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

1. Loads a batch of 28 at-risk transactions (25 fully synthetic + 3 wired to
   real people — see §6).
2. For each one, an LLM **diagnoses** why it likely failed and **recommends**
   one recovery action.
3. The app **executes** that action:
   - A retry action creates a **real Razorpay test-mode Payment Link** —
     a genuine, payable hosted checkout page.
   - Every other action logs a customer-facing message into the audit trail.
4. **For the 3 real-customer transactions**, that message (with the payment
   link embedded, for retries) is emailed for real via Brevo, with Yes / No /
   "I paid another way" response buttons — the transaction freezes as
   `waiting_for_response` until the customer actually clicks one.
5. **For every other (synthetic) transaction**, a weighted-random simulation
   decides the outcome instead, so the demo doesn't depend on live clicks.
6. If not resolved, it **escalates** to a firmer action — up to 3 attempts,
   each with a realistic per-reason cool-down — then gives up gracefully and
   marks the case `unrecovered`.
7. Every step is logged into a full **audit trail** per transaction, including
   the real payment link and when the next attempt is scheduled.
8. A **dashboard** shows headline numbers, a sortable/selectable transactions
   table, and per-transaction batch runs. An **Insights** page turns the
   accumulated attempt history into recovery-rate analytics. A **Reset Demo
   Data** control wipes everything back to the pristine seed state for a
   repeat demo run.

The full spec this was built against is in `PROJECT_PLAN.md` in the repo root.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), TypeScript |
| Styling | Tailwind CSS v4 (CSS-first config, no `tailwind.config.ts`), Razorpay brand colors |
| UI components | shadcn/ui (Base UI) — Card, Table, Badge, Button, Sheet, AlertDialog, Checkbox, Progress, Skeleton |
| Backend | Next.js API routes (`app/api/**/route.ts`) — no separate server |
| Data storage | Plain JSON file, `data/transactions.json`, restorable from `data/transactions-seed.json` — no database |
| LLM | **Groq API** (`groq-sdk`), model `openai/gpt-oss-20b`, with rate-limit retry/backoff |
| Payments | **Razorpay Node SDK** (`razorpay`), test mode only — orders **and** real payable Payment Links |
| Email | **Brevo** transactional email API (raw REST), for the 3 real-customer transactions only |
| Validation | Zod, used to enforce the LLM only ever returns values from the fixed reason/action lists |

---

## 3. Project structure

```
app/
  page.tsx                              Dashboard (client component)
  insights/page.tsx                     Recovery-rate analytics (client component)
  confirm/page.tsx                      Email response landing page (server component)
  error.tsx                             App-wide error boundary
  api/
    transactions/route.ts               GET  — read current transaction state
    diagnose/route.ts                   POST — call the LLM to diagnose one transaction
    razorpay/create-order/route.ts      POST — create a real test-mode Razorpay order
    razorpay/webhook/route.ts           POST — verified Razorpay webhook receiver (dormant, see §8)
    run-batch/route.ts                  POST — run the agent loop (all transactions, or a selected subset)
    run-batch/progress/route.ts         GET  — poll in-flight batch progress for the progress bar
    reset/route.ts                      POST — restore data/transactions.json from the seed file

lib/
  types.ts                              Data model + fixed reason/action lists
  diagnose.ts                           LLM call (Groq) + JSON validation + rate-limit retry
  razorpay.ts                           Razorpay order + Payment Link creation, webhook signature verification
  email.ts                              Real transactional email via Brevo (Yes/No/Paid-elsewhere buttons)
  agent.ts                              The core recovery loop (diagnose → execute → email-or-simulate → escalate)
  match-quality.ts                      Pure well-matched-action logic (no server deps — shared by agent + Insights)
  batch-progress.ts                     In-memory progress counter for the run-batch progress bar
  transactions-store.ts                 Read/write data/transactions.json, reset-from-seed
  format.ts                             Currency + label formatting helpers

components/
  ui/                                   shadcn/ui primitives
  site-header.tsx                       Shared navy top nav with Dashboard/Insights links
  status-badge.tsx                      Shared status → color badge
  bar-list.tsx                          Horizontal bar-list chart used on the Insights page
  transaction-trail-sheet.tsx           Side panel showing a transaction's full audit trail

data/
  transactions.json                     The "database" — current, mutated by every run
  transactions-seed.json                Pristine copy, restored by "Reset Demo Data"
```

---

## 4. Data model (`lib/types.ts`)

```ts
type TransactionStatus =
  | "pending" | "in_progress" | "recovered" | "unrecovered"
  | "waiting_for_response"   // real email sent, frozen until the customer clicks a response link
  | "awaiting_payment";      // reserved for a real-webhook-confirmed flow, not used by default (see §8)

type AttemptOutcome =
  | "paid" | "no_response" | "declined_again"
  | "paid_elsewhere"        // customer settled outside our system — not counted as recovered by us
  | "awaiting_response"     // real email sent, customer hasn't clicked yet
  | "awaiting_payment";

interface RecoveryAttempt {
  attemptNumber: number;
  timestamp: string;
  diagnosedReason: string;
  recommendedAction: string;
  actionTaken: string;
  actionDetail: string;             // message text, or includes the real payment link for retries
  outcome: AttemptOutcome;
  razorpayOrderId?: string;
  paymentLinkId?: string;           // set when a real Razorpay Payment Link was created
  paymentLinkUrl?: string;          // the actual payable short_url
  nextAttemptEligibleAt?: string;   // ISO date-time this attempt's cool-down ends
  respondedAt?: string;             // when a real customer clicked a response link
}

interface Transaction {
  id: string;
  customerName: string;
  amount: number;
  type: TransactionType;
  trueFailureReason: FailureReason;  // hidden ground truth — never sent to the LLM
  createdAt: string;
  status: TransactionStatus;
  attempts: RecoveryAttempt[];
  nextEligibleAttemptDate?: string;
  customerEmail?: string;            // if set, this is a REAL transaction — real email instead of simulation
  customerPhone?: string;            // reserved for future real SMS/WhatsApp; not used yet
  pendingResponseToken?: string;     // one-time token for the current outstanding email confirmation link
}
```

`FAILURE_REASONS` and `RECOVERY_ACTIONS` are still the same fixed lists the
LLM is constrained to, enforced with Zod validation rather than prompting
alone. `trueFailureReason` is still never sent to the LLM — the diagnosis
stays genuinely blind.

---

## 5. The recovery loop, step by step (`lib/agent.ts`)

`runAgentForTransaction()` runs this loop, **up to 3 attempts, hard-capped in
code**:

### Step 1 — Diagnose
Calls Groq with the transaction's id, type, amount, customer name, and (on a
retry) which actions were already tried, so the AI escalates instead of
repeating itself. Response is Zod-validated JSON.

### Step 2 — Execute
- `retry_payment_same_method` / `retry_payment_alternate_method` → creates a
  **real Razorpay test-mode Payment Link** (`createRecoveryPaymentLink` in
  `lib/razorpay.ts`) — a genuine, payable checkout page, verifiable in the
  Razorpay test dashboard. The link is embedded directly into the customer
  message.
- Every other action → the message is logged into the audit trail as before;
  nothing is actually sent *unless* this is a real-customer transaction (see
  Step 3).

### Step 3 — Real customer vs. simulated outcome
- **If `transaction.customerEmail` is set** (the 3 real transactions): a real
  confirmation email is sent via Brevo — subject, message, and three response
  buttons (Yes I've paid / No, not yet / I paid another way). The
  transaction status becomes `waiting_for_response` and the loop **stops
  entirely** for this transaction. It only resumes when the customer actually
  clicks a link (`handleEmailResponse`, see §6) — not on a subsequent "Run
  Batch" click.
- **Otherwise** (the 25 synthetic transactions): a weighted coin-flip decides
  `paid` / `no_response` / `declined_again`, same mechanic as before —
  ~70% paid if the recommended action is a well-matched fix for the
  transaction's *true* hidden reason (`lib/match-quality.ts`), ~30% if it's
  generic/mismatched. This is what makes the recovery rate a genuine signal
  of diagnosis quality, not scripted.

### Step 4 — Escalate or stop
- **Paid** → `recovered`, stop.
- **AI recommended `mark_unrecoverable`** → `unrecovered`, stop immediately.
- **Not paid, attempts remain** → schedule the next attempt via the
  per-reason cool-down table (§7) and either continue immediately (0-hour
  reasons) or pause.
- **3rd attempt still not paid** → `unrecovered`. Frozen permanently.

Every step is pushed into `attempts[]` — shown in "View Trail," including the
real payment link URL and the next-attempt-eligible date where relevant.

---

## 6. Real-customer flow (3 of the 28 transactions)

Three transactions in the dataset (`TXN-0002`, `TXN-0004`, `TXN-0008`) carry a
real `customerEmail` (yours — or a teammate's — set locally in
`data/transactions.json` / `data/transactions-seed.json`, never committed).
Everything else about them runs through the identical agent loop as the
other 25 — same diagnosis, same escalation rules, same real Razorpay Payment
Links for retries. The only difference: instead of a simulated dice-roll
outcome, a **real email goes out** (`lib/email.ts`, via Brevo) and the
transaction freezes as `waiting_for_response` until a human actually responds.

- **`GET /confirm?t=<id>&r=<paid|not_paid|paid_elsewhere>&token=<token>`**
  (`app/confirm/page.tsx`) is the landing page each button links to. It calls
  `handleEmailResponse()` in `lib/agent.ts`, which:
  - validates the one-time `pendingResponseToken` (rejects reused/invalid links),
  - **"Yes, I've paid"** → `recovered`, done.
  - **"I paid another way"** → `unrecovered` (`paid_elsewhere` — settled
    outside our system, not counted as something *we* recovered).
  - **"No, not yet"** → if attempts remain, schedules the next real email
    (at least a 1-hour gap, even for "immediate" reasons — don't re-email a
    real person seconds after they said no); otherwise `unrecovered`.
- This is the same hard-stop logic as the automated loop — one shared set of
  rules, not a special case.

This subset exists specifically to demonstrate the flow end-to-end with a
real inbox and a real, clickable payment link, without depending on 25
strangers actually receiving email.

---

## 7. Realistic pacing between attempts (`RETRY_DELAY_HOURS`)

Unchanged from the original design — a per-diagnosed-reason cool-down table
in `lib/agent.ts`:

| Reason | Delay | Why |
|---|---|---|
| `otp_timeout` | immediate | OTP and checkout session are already stale by tomorrow |
| `bank_server_error` | immediate | Transient outages usually clear in minutes |
| `customer_distraction` | 6h | Same-day cart-abandonment nudge |
| `payment_method_declined` | 12h | Short pause before suggesting an alternate method |
| `card_expired` | 24h | Customer needs time to add a new card |
| `international_card_block` | 24h | Customer needs time to call their bank |
| `insufficient_funds` | 48h | Needs real time for funds to arrive |
| `invoice_not_reviewed` | 72h | B2B approval workflows take days |

When a delay applies, the transaction becomes `in_progress` with
`nextEligibleAttemptDate` set, and the loop pauses until that time passes —
visible in "View Trail" as "Next attempt scheduled for [date]."

---

## 8. Real Razorpay Payment Links, and the webhook (now live — see §16)

> **Update:** the "dormant webhook" description below is from an earlier
> build. The webhook is now fully wired in and is the authoritative source
> of truth for payment status — see §16 and §17 for what changed and how
> it was verified. The rest of this section is kept for history.

Every retry action (`retry_payment_same_method` / `retry_payment_alternate_method`)
creates a **real, payable Razorpay test-mode Payment Link** via
`createRecoveryPaymentLink()` — not just a bare order. It's a genuine hosted
checkout page you can open and pay against in Razorpay's test mode (zero real
money, enforced in code — `lib/razorpay.ts` refuses to run against anything
but an `rzp_test_` key).

A signature-verified webhook receiver already exists
(`app/api/razorpay/webhook/route.ts` + `verifyWebhookSignature()` +
`handlePaymentWebhookEvent()` in `lib/agent.ts`) that *could* mark a
transaction `recovered` the instant Razorpay confirms a real payment on one
of these links. **It's intentionally not wired into the default flow** — for
the hackathon demo, whether a retry link gets "paid" is decided the same way
as every other action: a real email + real click for the 3 real transactions,
a weighted simulation for the other 25. Nothing currently calls this route.
Wiring it up in a real product would mean removing the retry-simulation
branch and letting the webhook be the sole source of truth for retry
outcomes instead.

`RAZORPAY_WEBHOOK_SECRET` is a separate secret from `RAZORPAY_KEY_SECRET` —
set in the Razorpay dashboard under Settings → Webhooks, not derived from
your API key.

---

## 9. API routes

| Route | Method | Does |
|---|---|---|
| `/api/transactions` | GET | Returns current state of all transactions |
| `/api/diagnose` | POST | Diagnoses one transaction (also directly testable) |
| `/api/razorpay/create-order` | POST | Creates one real Razorpay test-mode order |
| `/api/run-batch` | POST | Runs the agent loop — over every transaction, or over a specific `transactionIds` subset if the dashboard has a selection — 5 at a time concurrently, saves results, returns a summary + per-transaction errors |
| `/api/run-batch/progress` | GET | Polled by the dashboard's progress bar while a batch is in flight |
| `/api/reset` | POST | Overwrites `data/transactions.json` with the pristine `data/transactions-seed.json` |
| `/api/razorpay/webhook` | POST | Signature-verified Razorpay webhook receiver (dormant — see §8) |

All routes have explicit error handling — a failed LLM call, a failed
Razorpay/Brevo call, or a bad request body returns a clear JSON error, never
an unhandled crash.

---

## 10. The dashboard (`app/page.tsx`)

- **Shared top nav** (`components/site-header.tsx`) — Razorpay wordmark on
  navy, with Dashboard/Insights links, active-route highlighting.
- **Summary cards** — Total At Risk, Total Recovered, Recovery Rate, Cases
  Processed.
- **Selective run** — checkboxes per row (+ select-all); the "Run Batch"
  button becomes "Run Selected (N)" when rows are checked, and posts only
  those `transactionIds`. With nothing selected, it runs every transaction.
- **Live progress bar** — while a run is in flight, polls
  `/api/run-batch/progress` every 600ms and shows "N of M (X%)".
- **Sortable table** — click any column header (ID, Customer, Amount, Type,
  Status, Attempts) to sort; click again to reverse. Status sorts by a
  "needs attention first" rank (pending → waiting_for_response →
  awaiting_payment → in_progress → recovered → unrecovered), not alphabetically.
- **Reset Demo Data** — button + confirmation dialog; restores every
  transaction to its pristine seed state for a repeat demo.
- **View Trail** (`components/transaction-trail-sheet.tsx`) — full
  attempt-by-attempt audit trail per transaction, including the real payment
  link (if any) and the next-attempt-eligible date.

Brand theme (navy `#0C2451`, blue accent `#3395FF`, background `#F9FAFB`,
green/red/amber status colors, Inter font) is defined in `app/globals.css`
using Tailwind v4's CSS-first `@theme` config.

---

## 11. The Insights page (`app/insights/page.tsx`)

A second page (`/insights`, linked from the top nav) that turns the
accumulated attempt history into analytics — built with the `dataviz`
skill's bar-list pattern using the app's own brand colors rather than a
charting library:

- **Recovery rate by diagnosed reason** — which failure reasons convert best.
- **Recovery rate by recommended action** — which actions actually work.
- **Recovery rate by transaction type**.
- **Well-matched vs. mismatched actions** — the key validation chart: proves
  the agent's core "AI quality matters" mechanic is real, by directly
  comparing the paid-rate of well-matched vs. generic/mismatched actions
  (via `lib/match-quality.ts`, shared — not duplicated — with `lib/agent.ts`).
- **Attempts needed to resolve** — how many transactions closed on attempt 1
  vs. needed escalation, vs. are still unresolved.

Empty/loading states are handled the same way as the dashboard. `lib/match-quality.ts`
exists specifically so this client component can reuse the well-matched-action
logic without transitively importing `lib/agent.ts`'s server-only (`fs`) dependencies.

---

## 12. Error handling & resilience

- **Per-attempt errors don't kill the batch.** A failed diagnosis or
  execution for one transaction is recorded and the batch moves on.
- **Groq rate-limit retries** — `lib/diagnose.ts` retries a 429 with the
  server-reported backoff before giving up.
- **App-wide error boundary** (`app/error.tsx`).
- **Loading & empty states** everywhere — skeletons, explicit empty-state
  messaging, disabled buttons during in-flight requests.
- **Idempotent webhook handling** — the dormant webhook route only ever acts
  on a matching `awaiting_payment` attempt and no-ops safely on redelivery or
  an already-resolved transaction.

---

## 13. Environment setup

Copy `.env.local.example` to `.env.local` and fill in:

```
GROQ_API_KEY=                       # console.groq.com — free tier
RAZORPAY_KEY_ID=rzp_test_...        # dashboard.razorpay.com, Test Mode → API Keys
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=            # separate secret, set in the dashboard's webhook config — see §8
BREVO_API_KEY=                      # app.brevo.com — for the 3 real-customer emails
BREVO_SENDER_EMAIL=                 # must be a sender verified in your Brevo account
APP_BASE_URL=http://localhost:3000  # used to build the /confirm links inside recovery emails
```

`.env.local` is gitignored — never commit real keys. `lib/razorpay.ts`
explicitly refuses to run with anything that isn't a `rzp_test_` key, so
there's no risk of accidentally hitting live mode. If you want the
real-customer flow to actually work, edit `customerEmail` on `TXN-0002` /
`TXN-0004` / `TXN-0008` in **both** `data/transactions.json` and
`data/transactions-seed.json` (the seed file is what "Reset Demo Data"
restores from) — the committed copies use a placeholder address.

Then:
```
npm install
npm run dev
```
Dashboard runs at `http://localhost:3000`.

---

## 14. Known constraints

- **Test mode only.** No real payments are ever possible — enforced in code,
  not just convention.
- **Reminders/SMS/WhatsApp/calls stay simulated** for the 25 synthetic
  transactions; only Razorpay Payment Links and (for the 3 real transactions)
  Brevo email are genuine external calls. Intentional scope decision, not a
  gap to fix.
- **The dataset is sized at 28 transactions** so a full batch run comfortably
  fits Groq's free-tier rate limits and finishes quickly.
- ~~The webhook route is dormant by design~~ — no longer true, see §16/§17;
  the webhook is now the authoritative source of payment status for every
  transaction, real or synthetic.

---

## 15. What's not built yet

- Deployment to Vercel (should work with zero extra config, untested).
- A production-realistic scheduler for the per-reason cool-downs (currently
  you trigger the next eligible attempt by clicking "Run Batch" again after
  the date passes; a real system would run this on a cron instead).
- ~~Wiring the existing webhook receiver into the default retry flow~~ — done,
  see §16/§17. The webhook is now the authoritative source of payment status.

---

## 16. "Run Agent" pipeline integration — staged progress + run report

The most recent feature work wired every previously-built piece (Recovery
Cases, Customer Recovery Intelligence, the Recovery Decision Engine, the
bounded workflow, the Human Escalation Queue, Promise-to-Pay, real webhook
sync) into a single, visibly-narrated "Run Agent" pipeline behind the
existing "Run Batch" button — rather than adding new backend logic, since
essentially all 20 requested pipeline steps already existed from earlier
tasks. The actual new work was making that pipeline **visible** and giving it
a proper **end-of-run report**:

- **`lib/batch-progress.ts`** — the in-memory batch-progress tracker gained a
  `stage: BatchStage` field alongside `total`/`completed`/`running`, cycling
  through 9 named stages: `scanning` → `finding_revenue_at_risk` →
  `analysing_customer_history` → `calculating_scores` → `finding_root_causes`
  → `selecting_strategies` → `executing_actions` → `monitoring_payments` →
  `completed`. The first three are set at genuine one-time sequential
  boundaries in `run-batch/route.ts`, before the concurrent worker pool
  starts; the middle four are driven by real completion-fraction thresholds
  during the concurrent phase (honest, not a fake timer); `monitoring_payments`
  covers the final re-sync/finalize pass.
- **`app/api/run-batch/route.ts`** — calls `setBatchStage(...)` at each of
  those boundaries, and the response `summary` gained four new fields
  computed by diffing pre-run vs. post-run state: `transactionsAnalysed`
  (transactions this run actually touched, not the whole book),
  `recoveryCasesCreated` (genuinely new cases this run), `actionsExecuted`
  (decisions that reached `executeAction()` — excludes wait/stop/escalate),
  and `humanEscalations` (transactions newly escalated this run, not the
  total queue size).
- **`app/page.tsx`** — the progress banner became a visual stepper (checkmark
  for each completed stage, spinner on the active one, matching the
  requested arrow-chain flow), and a new "Agent Run Report" panel appears
  after each run showing all 7 requested metrics: Transactions Analysed,
  Revenue at Risk, Recovery Cases Created, Actions Executed, Human
  Escalations, Revenue Recovered, Recovery Rate.

Verified with two full live 28-transaction batch runs (stage transitions
polled and confirmed in order; summary math cross-checked against direct API
inspection) and Playwright screenshots of both the mid-run stepper and the
post-run report.

---

## 17. End-to-end audit (20 scenarios) and fixes

A full audit against 20 required test scenarios (payment failure, multi-attempt
recovery, pending/duplicate/delayed/idempotent webhooks, disputes, opt-out,
max retries/reminders, high-value escalation, promise-to-pay kept/broken,
API/email failures, running the agent twice, an already-paid order being
re-scanned) plus a cross-cutting checklist (no duplicate links/reminders, no
action after payment, no infinite loops, correct amounts, no double-counted
revenue, idempotent webhooks, escalation actually stops automation, every
decision audit-trailed). Tested via deterministic unit tests against the
Decision Engine directly, live signed-webhook and admin-action HTTP tests
against a running server, and code review. Found and fixed three real issues:

1. **Admin actions bypassed the per-transaction lock.** `lib/manual-payment-actions.ts`,
   `lib/escalation-actions.ts`, and the flags/promise-to-pay routes wrote to a
   transaction directly, unlike the agent loop, webhook processor, and
   email-response handler, which all acquire `lib/agent-lock.ts`'s lock
   first. An admin action landing at the same moment as a webhook or batch
   run on the same order could silently lose one side's update. Fixed by
   wrapping every admin write path with the same lock/release pattern.
2. **Duplicate-payment detection was unreachable.** In
   `lib/razorpay-webhook.ts`, `handleSuccess`'s "already paid → ignore" guard
   ran *before* the duplicate-successful-payment check, but any captured
   payment already implies "already paid" — so a second, genuinely different
   successful payment on an already-recovered order was silently ignored
   instead of escalating for human review. Fixed by reordering the two
   checks (the checks themselves were unchanged and correct).
3. **`customerOptedOut` was write-only in theory, unreachable in practice.**
   The Decision Engine read it, but nothing in the app ever set it. Added
   `setCustomerOptOut()` (lock-protected, audit-trailed like every other
   admin action), a new `opt_out_customer` / `opt_in_customer` action on the
   transaction-action route, and an "Opt Customer Out" button in the trail
   sheet.

**Known limitations surfaced, not changed:** the `/confirm` email links
mutate state on a bare GET (an email client's automatic link-prefetch could
resolve a transaction before the customer clicks it — idempotent on
redelivery, but the first automated hit is a real risk with a real inbox
that does link-scanning); an offline payment's optional partial `amount` is
still treated as full recovery by `isOrderPaid`; a promise-to-pay deadline
only resolves to kept/broken when something next touches that transaction
(no background scheduler). All three are pre-existing design trade-offs, not
regressions — flagged rather than silently rewritten.

---

## 18. Diagnosis quality — gateway error hints (fewer "unknown" root causes)

Root-cause diagnoses were landing on `unknown` far more than expected —
correctly so, given what the AI actually had to work with. Each transaction
only carried a coarse `type` (`payment_failed` / `checkout_abandoned` /
`subscription_failed` / `invoice_overdue`) and `amount`; `trueFailureReason`
is deliberately hidden (it's simulation ground truth, not something a real
gateway would ever hand the AI). For `checkout_abandoned`/`invoice_overdue`
that's plenty of signal, but for `payment_failed`/`subscription_failed` it's
genuinely ambiguous between 7 different root causes — so the AI, correctly
following its own instructions ("don't force-fit a cause you can't support"),
defaulted to `unknown` + `low` confidence on most first attempts.

- **`Transaction.gatewayErrorHint`** (`lib/types.ts`) — a realistic,
  gateway-style error message available at the time of the *original*
  failure (e.g. `"Card declined — issuer reports the card has expired."`),
  mirroring what a real Razorpay failed-payment webhook/API response would
  already show a merchant, even before any recovery attempt. Populated in
  the seed data for the 20 of 28 transactions where a real gateway attempt
  would plausibly have occurred — deliberately omitted for
  checkout-abandonment/pure-overdue-invoice cases, where no payment was ever
  actually attempted.
- **`lib/diagnose.ts`** — this hint (plus, on a retry, a REAL Razorpay
  webhook-reported failure reason for this order's own most recent payment
  attempt — `lib/agent.ts` distinguishes genuine gateway data from the
  system's own simulated guesses by checking `PaymentAttempt.razorpayPaymentId`)
  is fed into the diagnosis prompt with explicit instructions to treat it as
  real evidence: name a specific cause with high confidence when the hint
  clearly supports one, and reserve `unknown` for when there's truly no
  signal at all (a bare "declined, no code" hint still supports `bank_decline`
  specifically — that much genuinely is known).

Verified live: 5 previously-`unknown` transactions all resolved to their
exact hidden root cause with `high` confidence once hinted (network_failure,
insufficient_funds, card_failure, bank_decline, authentication_failure);
un-hinted checkout-abandonment/overdue-invoice cases were unaffected, still
correctly diagnosed from `type` alone. A useful side effect: with genuine
high confidence, the policy engine now mints a real Payment Link on the
first attempt where it used to conservatively `wait`.

---

## 19. Customer history & the customer detail page

Every customer in the dataset had exactly one transaction — nothing for
Customer Recovery Intelligence to actually learn a *pattern* from, and no
way to drill into a customer's full track record from the UI.

- **`data/customer-history.json`** — one realistic, already-resolved PAST
  transaction per customer (28 total), each with full attempt/decision/
  payment-attempt detail, generated with genuine variety rather than cloned:
  8 recovered on the first attempt via a real payment link, 8 via an email
  reminder, 6 recovered on the *second* attempt (reminder failed, then a
  payment link succeeded), 6 never recovered (3 failed attempts, handed
  off). Payment delays range 2h–367h.
- **`lib/customer-history-store.ts`** — reads that file. Deliberately its
  own permanent store, separate from `transactions.json`/`transactions-seed.json`:
  it never appears in the operational Dashboard/Insights/Overview tables
  (which should only reflect the *current* at-risk batch), and — this is the
  important part — **it is never touched by `POST /api/reset`**. "Reset Demo
  Data" resets the current session's mutable state; this is permanent
  baseline history and survives every reset.
- Wired into three places: `/api/customers` and `/api/customers/[customerId]`
  (combined with live transactions before profiles/scores are built), and
  `run-batch/route.ts`'s `customerHistory` context — so the AI's diagnosis
  prompt for a customer's current at-risk transaction now sees their real
  track record, not a blank slate.
- **`app/customers/[customerId]/page.tsx`** (new) — clicking a customer on
  `/customers` now navigates to a full detail page instead of opening a side
  sheet: a Risk badge (Low/Medium/High + the 0–100 score), stat tiles, the
  full Recovery Score factor breakdown, and a complete transaction history
  table (Failed On / Recovered On dates, status, attempts, drill-down into
  the same attempt-by-attempt trail used everywhere else). `site-header.tsx`'s
  active-nav-tab logic was fixed to recognize `/customers/*` sub-pages as
  part of the Customers section (it previously only matched exact paths).

---

## 20. Dashboard: Current vs. Previous Records

`app/page.tsx` now has two views behind a sliding tab switcher instead of one
long page:

- **Current Records** — the existing operational table, unchanged, plus a
  5th stat card, **Remaining** (`Total At Risk − Total Recovered`).
- **Previous Records** (new) — reads `/api/customer-history`: its own 5
  money stats scoped to history only, **Avg Attempts to Resolve**, **Avg
  Time to Recover**, a **Recovered via** channel breakdown (Payment Link /
  Reminder / Unrecovered, red bar for the unrecovered slice), a "What this
  tells the agent" card of auto-generated plain-English observations, and
  the full previous-transactions table.
- **Reset Demo Data** and **Run Batch** only render on the Current Records
  tab now — they have no meaning against read-only history, and used to
  show regardless of which tab was active.
- **Find + date-range filter, on both tables**, plus a sortable **Created**
  column on Current Records (it didn't show any date before) and sortable
  **Failed On**/**Recovered On** columns on Previous Records (previously
  static, date-only — now date + time).
- **Filtering scopes what the agent analyses.** If the table is narrowed by
  the find/date filter and no row is explicitly checked, the Run Batch
  button becomes **"Run Filtered (N)"** and only sends that visible subset —
  explicit checkbox selection still takes priority over the filter. "Select
  all" likewise selects only the currently-visible rows, not the whole
  underlying set.

---

## 21. Smarter escalation — relative amount-spike detection

The existing `high_value_transaction` rule (§ Recovery Decision Engine, in
`lib/recovery-decision-engine.ts`) is a flat threshold: any order at or above
₹10,000 (configurable) escalates, for every customer alike. That misses a
real anomaly the other direction: a customer whose normal spend is, say,
₹100 suddenly attempting ₹5,000 is a meaningful signal on its own — well
under the flat threshold, but a 50x jump from *their own* baseline.

- **New rule, `unusual_amount_spike`** — runs alongside (not instead of) the
  flat threshold, on the first attempt only. Compares the order amount
  against this specific customer's own average PAST transaction amount
  (`lib/customer-recovery.ts`'s `buildAveragePastAmountByCustomer`, computed
  strictly from `customer-history.json` — never from the transaction
  currently being evaluated, so the anomaly can't dilute its own baseline).
  Escalates when the amount is **≥ 5x** that average (configurable via
  `RECOVERY_AMOUNT_SPIKE_MULTIPLIER`). A customer with no history yet is
  correctly skipped — nothing to be "sudden" relative to.
- Both rules can fire together: an order that's genuinely large *and* a
  spike for that specific customer carries both reasons in the Escalation
  Queue.
- The customer's historical average is also mentioned in the diagnosis
  prompt for extra AI context, but the actual escalation decision stays
  fully deterministic in the policy engine — consistent with how every other
  rule here works; the AI never decides this on its own judgment.

Verified with 5 targeted decision-engine scenarios (the small-customer-spike
case, a large-but-normal-for-them case, no-history, flat-threshold-still-works,
both-rules-firing-together) plus a full regression pass on the pre-existing
rules.
