# AI Revenue Recovery Agent — Project Overview

Built for the Razorpay Hackathon, Track 03: AI Revenue Recovery.

This document explains what's been built, how it works, and how to run it — for
teammates who weren't in the room while it was built.

---

## 1. What this project does

Merchants lose revenue not in one clean step, but through a chain of small
failures: a payment fails, a customer abandons checkout, a subscription
auto-debit bounces, or a B2B invoice goes overdue. This app is an **AI agent**
that automates recovering that revenue end-to-end:

1. Loads a batch of synthetic "at-risk" transactions.
2. For each one, an LLM **diagnoses** why it likely failed and **recommends**
   one recovery action.
3. The app **executes** that action — a real Razorpay test-mode payment retry,
   or a simulated reminder/incentive/escalation.
4. A weighted-random simulation decides whether the "customer" responds.
5. If not resolved, it **escalates** to a firmer action — up to 3 attempts,
   then gives up gracefully and marks the case `unrecovered`.
6. Every step is logged into a full **audit trail** per transaction.
7. A dashboard shows headline numbers (₹ at risk, ₹ recovered, recovery rate)
   and lets you click into any transaction's history.

The full spec this was built against is in `PROJECT_PLAN.md` in the repo root.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), TypeScript |
| Styling | Tailwind CSS v4 (CSS-first config, no `tailwind.config.ts`), Razorpay brand colors |
| UI components | shadcn/ui — Card, Table, Badge, Button, Sheet, Skeleton |
| Backend | Next.js API routes (`app/api/**/route.ts`) — no separate server |
| Data storage | Plain JSON file, `data/transactions.json` — no database |
| LLM | **Groq API** (`groq-sdk`), model `openai/gpt-oss-20b` |
| Payments | **Razorpay Node SDK** (`razorpay`), test mode only |
| Validation | Zod, used to enforce the LLM only ever returns values from the fixed reason/action lists |

---

## 3. Project structure

```
app/
  page.tsx                       Dashboard (client component)
  error.tsx                      App-wide error boundary
  api/
    transactions/route.ts        GET  — read current transaction state
    diagnose/route.ts            POST — call the LLM to diagnose one transaction
    razorpay/create-order/route.ts   POST — create a real test-mode Razorpay order
    run-batch/route.ts           POST — run the full agent loop across all transactions

lib/
  types.ts                       Data model + fixed reason/action lists
  diagnose.ts                    LLM call (Groq) + JSON validation
  razorpay.ts                    Razorpay order creation, test-mode enforced
  agent.ts                       The core recovery loop (diagnose → execute → simulate → escalate)
  transactions-store.ts          Read/write data/transactions.json
  format.ts                      Currency + label formatting helpers

components/
  ui/                            shadcn/ui primitives
  status-badge.tsx                Shared status → color badge
  transaction-trail-sheet.tsx     Side panel showing a transaction's full audit trail

data/
  transactions.json               The "database" — synthetic seed transactions
```

---

## 4. Data model (`lib/types.ts`)

```ts
type TransactionType =
  | "payment_failed" | "checkout_abandoned"
  | "subscription_failed" | "invoice_overdue";

type FailureReason =
  | "card_expired" | "insufficient_funds" | "otp_timeout"
  | "bank_server_error" | "international_card_block"
  | "customer_distraction" | "payment_method_declined"
  | "invoice_not_reviewed";

type RecoveryAction =
  | "send_sms_reminder" | "send_whatsapp_reminder" | "send_email_reminder"
  | "retry_payment_same_method" | "retry_payment_alternate_method"
  | "offer_incentive_discount"
  | "escalate_to_call" | "escalate_to_account_manager"
  | "mark_unrecoverable";

interface Transaction {
  id: string;
  customerName: string;
  amount: number;                      // INR
  type: TransactionType;
  trueFailureReason: FailureReason;    // hidden ground truth — never shown to the LLM
  createdAt: string;
  status: "pending" | "recovered" | "unrecovered" | "in_progress";
  attempts: RecoveryAttempt[];
  nextEligibleAttemptDate?: string;    // ISO date — set when this transaction is "cooling down"
}

interface RecoveryAttempt {
  attemptNumber: number;
  timestamp: string;
  diagnosedReason: string;
  recommendedAction: string;
  actionTaken: string;                 // e.g. "sent_sms_reminder", "razorpay_retry"
  actionDetail: string;                // the message text, or the Razorpay order id
  outcome: "paid" | "no_response" | "declined_again";
  razorpayOrderId?: string;
  nextAttemptEligibleAt?: string;      // when this specific attempt scheduled the next one
}
```

`FAILURE_REASONS` and `RECOVERY_ACTIONS` (the fixed lists above) are exported
as arrays too, and the LLM is constrained to only ever pick from them —
enforced with Zod validation, not just prompting.

**Important:** `trueFailureReason` is the "ground truth" used only by the
outcome-simulation logic. It is **never sent to the LLM** — the AI diagnoses
blind, from just the transaction's visible metadata (id, type, amount,
customer name). This is what makes the recovery rate a genuine signal of
diagnosis quality rather than a rigged demo.

---

## 5. The recovery loop, step by step (`lib/agent.ts`)

For each transaction, `runAgentForTransaction()` runs this loop, **up to 3
attempts, hard-capped in code** (not left to the AI):

### Step 1 — Diagnose
Calls Groq (`lib/diagnose.ts`) with the transaction's id, type, amount, and
customer name — plus, on a retry, which actions were already tried, so the AI
escalates instead of repeating itself. Groq returns JSON:
```json
{ "reason": "...", "recommendedAction": "...", "customerMessage": "..." }
```
This is validated against the fixed lists with Zod. If it fails validation or
isn't valid JSON, that's treated as an error for this attempt (see §8).

### Step 2 — Execute
- If the action is `retry_payment_same_method` or `retry_payment_alternate_method`
  → calls the **real Razorpay test API** and creates a genuine test-mode order
  (`lib/razorpay.ts`). Verifiable in the Razorpay test dashboard's Orders tab.
- For every other action → nothing is actually sent. The customer message is
  just logged into the audit trail (`actionDetail`), as if it had been sent.

### Step 3 — Simulate the outcome
A weighted coin-flip decides `paid` / `no_response` / `declined_again`. The
weighting is the core "AI quality matters" mechanic:

- If the recommended action is a **well-matched** fix for the transaction's
  *true* hidden reason → ~70% chance of `paid`.
- If it's a **generic/mismatched** action → ~30% chance.

The match table lives in `agent.ts` as `WELL_MATCHED_ACTIONS`. This means a
smarter diagnosis genuinely produces a higher recovery rate — it's not
scripted.

### Step 4 — Escalate or stop
- **Paid** → mark `recovered`, stop.
- **AI recommended `mark_unrecoverable`** → mark `unrecovered`, stop
  immediately, even if attempts remain.
- **Not paid, attempts remain** → schedule the next attempt (see §6) and
  either continue right away or pause.
- **3rd attempt still not paid** → mark `unrecovered`. Frozen — no further
  action, ever, even if you run the batch again.

Every step gets pushed into that transaction's `attempts[]` — the audit
trail shown in "View Trail."

---

## 6. Realistic pacing between attempts (`RETRY_DELAY_HOURS`)

Not every failure reason should be retried the same way. `lib/agent.ts` has a
per-diagnosed-reason cool-down table:

| Reason | Delay | Why |
|---|---|---|
| `otp_timeout` | immediate | OTP and checkout session are already stale by tomorrow — only an instant retry helps |
| `bank_server_error` | immediate | Transient outages usually clear in minutes, not days |
| `customer_distraction` | 6h | Same-day cart-abandonment nudge |
| `payment_method_declined` | 12h | Short pause before suggesting an alternate method |
| `card_expired` | 24h | Customer needs time to add a new card |
| `international_card_block` | 24h | Customer needs time to call their bank |
| `insufficient_funds` | 48h | Needs real time for funds to arrive |
| `invoice_not_reviewed` | 72h | B2B approval workflows take days |

When a delay applies, the transaction's status becomes `in_progress` with
`nextEligibleAttemptDate` set, and the loop **pauses** — it won't process
that transaction again until that time passes, even across multiple "Run
Batch" clicks. This is visible in the "View Trail" panel: a banner shows
"Waiting to escalate — next attempt eligible on [date]," and the specific
attempt that triggered the wait shows "Next attempt scheduled for [date]
(based on the [Reason] cool-down)."

---

## 7. API routes

| Route | Method | Does |
|---|---|---|
| `/api/transactions` | GET | Returns current state of all transactions, for the dashboard's initial load |
| `/api/diagnose` | POST | Diagnoses one transaction (used internally by the agent loop; also directly testable) |
| `/api/razorpay/create-order` | POST | Creates one real Razorpay test-mode order |
| `/api/run-batch` | POST | Runs the full agent loop across every transaction (5 at a time, concurrently), saves results back to `data/transactions.json`, returns a summary |

All routes have explicit error handling — a failed LLM call, a failed
Razorpay call, or a bad request body returns a clear JSON error with an
appropriate status code, never an unhandled crash.

---

## 8. Error handling & resilience

- **Per-attempt errors don't kill the batch.** If diagnosis or execution
  fails for one transaction's attempt, `run-batch` records the error and
  moves on to the next transaction — the whole run doesn't crash.
- **Groq rate-limit retries.** Groq's free tier caps at 8000 tokens/minute
  shared across the whole account. `lib/diagnose.ts` automatically retries a
  429 (rate limit) with the server-reported backoff before giving up, so
  brief bursts don't fail attempts outright.
- **App-wide error boundary** (`app/error.tsx`) catches any unexpected
  render-time crash and shows a clear "Something went wrong" screen with a
  retry button, instead of a blank page.
- **Loading & empty states** everywhere — skeleton placeholders while data
  loads, explicit empty-state messaging, disabled buttons during in-flight
  requests.

---

## 9. The dashboard (`app/page.tsx`)

- **Top nav** — the real Razorpay wordmark (extracted from razorpay.com's own
  site, not fabricated) + "Revenue Recovery Agent" title, on a navy header.
- **Summary cards** — Total At Risk, Total Recovered, Recovery Rate, Cases
  Processed, each with a small icon, computed from the current transaction
  list.
- **"Run Batch" button** — calls `POST /api/run-batch`, shows a loading
  spinner, then refreshes everything from the response.
- **Transactions table** — ID, Customer, Amount, Type, Status (color-coded
  badge: green=recovered, red=unrecovered, amber=in progress, gray=pending),
  Attempts count, and a "View Trail" button per row.
- **View Trail** (`components/transaction-trail-sheet.tsx`) — a side panel
  showing that transaction's full attempt-by-attempt history: diagnosed
  reason, recommended action, action taken, outcome, the actual message/order
  id, and (if applicable) when the next attempt is scheduled.

Brand theme (navy `#0C2451`, blue accent `#3395FF`, background `#F9FAFB`,
green/red/amber status colors, Inter font) is defined in `app/globals.css`
using Tailwind v4's CSS-first `@theme` config.

---

## 10. Environment setup

Copy `.env.local.example` to `.env.local` and fill in:

```
GROQ_API_KEY=            # console.groq.com — free tier
RAZORPAY_KEY_ID=rzp_test_...   # dashboard.razorpay.com, Test Mode → API Keys
RAZORPAY_KEY_SECRET=
```

`.env.local` is gitignored — never commit real keys. `lib/razorpay.ts`
explicitly refuses to run with anything that isn't a `rzp_test_` key, so
there's no risk of accidentally hitting live mode.

Then:
```
npm install
npm run dev
```
Dashboard runs at `http://localhost:3000`.

---

## 11. Known constraints

- **Groq free tier = 8000 tokens/minute**, shared across your whole account
  regardless of model. The dataset is currently sized at **12 transactions**
  (not the original 45) specifically so a full batch run comfortably fits
  under that budget and finishes in under a minute. It was originally 45; if
  you want it back, or want a bigger dataset, be aware a full run will take
  several minutes and rely on the automatic rate-limit retry logic.
- **Test mode only.** No real payments are ever possible — enforced in code,
  not just convention.
- **Reminders/SMS/WhatsApp/calls are simulated, not sent.** Only the
  Razorpay payment retry is a real API call. This was an intentional
  scope decision (see `PROJECT_PLAN.md` §2) — not a limitation to fix.

---

## 12. What's not built yet

Per the original build order in `PROJECT_PLAN.md` §9, everything through
step 11 (dashboard + trail view + styling) is done. Remaining, if wanted:
- Deployment to Vercel (should work with zero extra config, untested).
- A production-realistic scheduler for the per-reason cool-downs (currently
  you trigger the next eligible attempt by clicking "Run Batch" again after
  the date passes; a real system would run this on a cron instead).
