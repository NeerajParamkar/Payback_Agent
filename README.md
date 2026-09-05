# Payback Agent

**AI Revenue Recovery Agent.**

Merchants lose revenue not in one dramatic failure but through dozens of small ones a
day — a card gets declined, a customer abandons checkout, a subscription auto-debit
bounces, an invoice goes overdue. Today, recovering that money is manual: someone in
finance/ops chases each one down by hand. **Payback Agent automates that entire
chase** — it scans at-risk transactions, diagnoses *why* each one likely failed, decides
the right next move, executes it for real, monitors the outcome, and only pulls in a
human when a case genuinely needs one.

The one architectural rule the whole system hangs off:

> **The AI only ever recommends. It never touches money or sends anything directly.**
> Every recommendation passes through a separate, fully deterministic policy engine
> that decides what's actually allowed — and every action is logged into a complete,
> attempt-by-attempt audit trail.

That split is what makes it safe to run this loop unattended: it's not one model making
financial decisions, it's an AI generating a recommendation, and hard business rules
deciding whether to trust it.

---

## Table of contents

- [How it works — the recovery loop, end to end](#how-it-works--the-recovery-loop-end-to-end)
- [A tour of the app, page by page](#a-tour-of-the-app-page-by-page)
- [The real-customer flow](#the-real-customer-flow-3-of-the-28-transactions)
- [Data model quick reference](#data-model-quick-reference)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Design principle, restated](#design-principle-restated)

---

## How it works — the recovery loop, end to end

Every transaction goes through the exact same nine-stage pipeline (visible live in the
dashboard's progress stepper when you click **Run Batch**):

```
scanning → finding revenue at risk → analysing customer history →
calculating scores → finding root causes → selecting strategies →
executing actions → monitoring payments → completed
```

### 1. Scan & score
The batch loads every transaction currently marked `pending`/`in_progress` (or just the
rows you've filtered/selected on the dashboard — a filtered view only analyses what's
on screen, nothing invisible happens outside it). For each customer, it pulls their
permanent history (`data/customer-history.json`) and the built-in customer scorer
computes a 0–100 recovery score from real signals: payment success rate, past recovery
success, response to reminders, failed-payment frequency, average payment delay,
payment-link conversion rate, and attempts-to-recover — a fully transparent weighted
model, not a black box (see [`lib/customer-scoring.ts`](lib/customer-scoring.ts)).

### 2. Diagnose (AI step)
[`lib/diagnose.ts`](lib/diagnose.ts) calls an LLM (Groq, `openai/gpt-oss-20b`) with the
transaction's realistic gateway-error hint (and, on a retry, any real Razorpay webhook
failure reason for that order) and asks it to pick one root cause from a **fixed
12-value taxonomy** — enforced with Zod, so the model can never invent a category. It
also picks a confidence level and one recommended action from a **fixed 9-value action
list**. Critically, the transaction's hidden `trueFailureReason` (the simulation's own
ground truth) is *never* sent to the model — diagnosis is genuinely blind, which is what
makes the eventual recovery rate a real signal of diagnosis quality instead of a
scripted number.

### 3. Decide (deterministic policy engine — not the AI)
The AI's raw recommendation is just that — a recommendation. It's handed to
[`lib/recovery-decision-engine.ts`](lib/recovery-decision-engine.ts), roughly 16
ordered rules that validate it against real business rules before anything is allowed
to execute. Rules run in order and the first match wins; highlights:

1. Manual admin flags always win.
2. Order already paid → `stop` immediately.
3. Retry limit exceeded → `escalate_to_human`.
4. Customer opted out → `stop`.
5. High-value order (flat ₹10,000 threshold, first attempt only) → `escalate_to_human`.
6. **`unusual_amount_spike`** — amount ≥5× *this specific customer's* own historical
   average → `escalate_to_human`, even if it's under the flat threshold above.
7. Low confidence beyond the first attempt → `escalate_to_human` (unless recovery
   probability still looks reasonable — reject a premature AI give-up).
8. Reminder cap / payment-link retry cap reached → escalate or stop.
9. An unresolved Payment Link already exists → `retry` (resend the existing one, never
   mint a duplicate).
10. Amount below a floor, or first-attempt confidence too low, or the customer's own
    track record is poor → defer minting a real link.
11. Customer recently said "not yet" → `track_promise_to_pay` instead of re-prompting
    immediately.
12. Same ineffective action already tried → don't repeat it.
13. Max recovery duration exceeded → `stop`.

Every rule pushes a `PolicyCheckResult` into the audit trail regardless of whether it
matched — full transparency into *why* a decision was made, not just what it was. The
engine's output is one of eight `DecisionAction` values (`wait`, `generate_payment_link`,
`send_email`, `retry`, `send_reminder`, `track_promise_to_pay`, `escalate_to_human`,
`stop`) — a vocabulary completely separate from the AI's own `RecoveryAction`
recommendation, and both are persisted per attempt so the audit trail never conflates
"what the AI suggested" with "what actually happened."

### 4. Execute
Only one `DecisionAction` ever performs a real financial operation:
`generate_payment_link` mints a genuine, payable **Razorpay test-mode Payment Link**
([`lib/razorpay.ts`](lib/razorpay.ts) — hard-refuses to run against anything but an
`rzp_test_` key). Every other action logs a customer-facing message into the audit
trail.

### 5. Monitor & respond
- **Real customer** (`customerEmail` set on the transaction) → a real email goes out via
  Brevo, the transaction freezes as `waiting_for_response`, and the loop stops
  completely until the customer actually clicks a response link. See
  [next section](#the-real-customer-flow-3-of-the-28-transactions).
- **Synthetic customer** (the other 25 transactions) → a weighted simulated outcome
  decides `paid` / `no_response` / `declined_again`. The odds are driven by
  [`lib/match-quality.ts`](lib/match-quality.ts): a well-matched action for the
  transaction's true (hidden) failure reason converts meaningfully better than a
  generic/mismatched one — proving the "diagnosis quality matters" premise with real
  numbers on the Insights page, not an assertion.
- Each cycle always pauses afterward via a **per-diagnosed-reason cooldown table**
  (e.g. immediate for a transient bank-server error, 24h for an expired card, 72h for an
  unreviewed B2B invoice — see [`lib/agent.ts`](lib/agent.ts)) — this is the
  "gradual, not spammy" escalation the whole system is built around.

### 6. Escalate what needs a human
Some cases should never be automated further: a duplicate payment, a suspicious spend
spike, a low-confidence diagnosis after repeated attempts, a customer explicitly asking
for a human. These land in the **Human Escalation Queue**
([`lib/escalation-queue.ts`](lib/escalation-queue.ts)) — an entry exists only while
`status === "escalated"`, and once there, automation stops **permanently** on that order
(checked before any diagnosis call) until an admin takes one of 6 actions: take
ownership, send a fresh payment link, record an offline payment, mark recovered, stop
recovery outright, or resolve. Every admin action is lock-protected by the same
per-order lock the automated loop uses, so an admin can never race a concurrent batch
run or webhook on the same order.

### 7. Confirm (real payments only)
For the real-customer flow, a **signature-verified, idempotent Razorpay webhook**
([`lib/razorpay-webhook.ts`](lib/razorpay-webhook.ts)) is the final authority: it
verifies the payload signature before parsing anything, checks a persisted event log
keyed by `<event type>:<entity id>` before mutating state (so a redelivered event is
safely recognized and skipped), and handles success, failure, pending
(authorized-not-captured), and refund events — a refund reopens the order if it's no
longer actually paid.

Underpinning all of this: a per-order in-memory lock
([`lib/agent-lock.ts`](lib/agent-lock.ts)) acquired by every write path — the automated
loop, email responses, webhooks, and admin actions — so two overlapping operations can
never double-send a reminder or mint two Payment Links on the same order.

---

## A tour of the app, page by page

| Page | What it shows |
|---|---|
| **Dashboard** (`/`) | 5 stat cards (Total At Risk, Total Recovered, Remaining, Recovery Rate, Cases), a searchable/sortable transactions table with date-range filtering, **Run Batch** (or **Run Filtered (N)** when a filter/selection is active), and a live stage-by-stage progress stepper while a run is in flight. Ends with a full **Agent Run Report**: transactions analysed, revenue at risk, cases created, actions executed, human escalations, revenue recovered, recovery rate. |
| **Previous Records** tab | Permanent per-customer history — one resolved transaction per customer, showing base recovery rate, typical attempts/time-to-collect, and which channel tends to close the deal. Doesn't reset with the demo data; it's what gives the agent's scoring an actual track record instead of guessing blind. |
| **Customers** (`/customers`) | Every customer scored 0–100 with a transparent breakdown of exactly how many points each of the 7 factors contributed, plus a risk label (≥70 low, 40–69 medium, <40 high). Click into anyone for their full transaction history — same data the agent itself reads before deciding how to approach them. |
| **Insights** (`/insights`) | Recovery rate broken down by root cause and by action taken, plus the key validation chart: well-matched actions vs. generic ones, proving diagnosis quality is a real driver of recovery, not a scripted outcome. |
| **Overview** (`/overview`) | The executive dashboard — money-first metrics, a full recovery funnel from failed payment to revenue recovered, and breakdowns by root cause, channel, customer segment, amount tier, time of day, and attempt number. Deliberately scoped to the *current* batch only (excludes Previous Records) so headline numbers stay honest. |
| **Escalations** (`/escalations`) | The human queue described above — click into any entry for the full context and the 6 available admin actions, every one audit-trailed. |
| **Confirm** (`/confirm`) | The landing page a real customer's email response link points to — Yes I've paid / No not yet / I paid another way. |

---

## The real-customer flow (3 of the 28 transactions)

25 of the 28 transactions are fully synthetic. **3 carry a real email address** and go
through a genuinely real Brevo email + Razorpay Payment Link flow, specifically to
prove the end-to-end integration actually works rather than just the simulation:

1. The agent creates a real, payable Razorpay test-mode Payment Link for a retry.
2. A real email goes out via Brevo with that link embedded and three response buttons.
3. The transaction freezes as `waiting_for_response` — automation stops until the
   customer actually clicks.
4. If they click **Yes, I've paid** → `recovered`. **I paid another way** →
   `unrecovered` (settled outside the system, not counted as something *we* recovered).
   **No, not yet** → schedules the next real email (at least a 1-hour gap, even for
   "immediate" cooldown reasons — never re-email a real person seconds after they say
   no).
5. If a real payment actually comes through instead, the signature-verified Razorpay
   webhook confirms it independently — the authoritative source of truth regardless of
   what the automated loop otherwise assumed.

---

## Data model quick reference

Fixed vocabularies, all enforced with Zod/TypeScript so nothing free-text leaks into a
decision (full definitions in [`lib/types.ts`](lib/types.ts)):

- **`TransactionType`** — `payment_failed`, `checkout_abandoned`, `subscription_failed`,
  `invoice_overdue`.
- **`RootCause`** (what the AI diagnoses, 12 values) — `bank_decline`,
  `network_failure`, `insufficient_funds`, `card_failure`, `upi_failure`,
  `authentication_failure`, `checkout_abandonment`, `payment_pending`,
  `repeated_payment_failure`, `overdue_payment`, `payment_order_mismatch`, `unknown`
  (a first-class value — the model is told to use it rather than force-fit a
  specific-sounding cause the evidence doesn't support).
- **`RecoveryAction`** (what the AI recommends, 9 values) — `send_sms_reminder`,
  `send_whatsapp_reminder`, `send_email_reminder`, `retry_payment_same_method`,
  `retry_payment_alternate_method`, `offer_incentive_discount`, `escalate_to_call`,
  `escalate_to_account_manager`, `mark_unrecoverable`.
- **`DecisionAction`** (what the policy engine actually authorizes, 8 values) — `wait`,
  `generate_payment_link`, `send_email`, `retry`, `send_reminder`,
  `track_promise_to_pay`, `escalate_to_human`, `stop`.
- **`TransactionStatus`** — `pending`, `in_progress`, `recovered`, `unrecovered`,
  `waiting_for_response`, `awaiting_payment`, `escalated`, `promise_to_pay`.
- **`EscalationReason`** (11 values) — `customer_disputed_payment`,
  `customer_claims_paid_unverified`, `duplicate_successful_payments`,
  `suspected_fraud`, `high_value_transaction`, `unusual_amount_spike`,
  `low_ai_confidence`, `max_attempts_reached`, `customer_requested_human`,
  `ambiguous_payment_status`, `complex_refund_issue`.

Both `recommendedAction` (the AI's raw suggestion) and `decisionAction` (what the
policy engine actually validated and executed) are persisted separately on every
attempt — the audit trail always shows both, never one conflated as the other.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router), TypeScript |
| Styling | Tailwind CSS v4 (CSS-first `@theme` config), shadcn/ui (Base UI) — Razorpay brand colors |
| Backend | Next.js API routes (`app/api/**/route.ts`) — no separate server |
| Data storage | Plain JSON files in `data/` — no database, restorable from seed files |
| LLM | Groq API (`groq-sdk`), model `openai/gpt-oss-20b`, with rate-limit retry/backoff |
| Payments | Razorpay Node SDK, test mode only — real orders **and** real payable Payment Links |
| Email | Brevo transactional email API, for the 3 real-customer transactions only |
| Validation | Zod — constrains the LLM to fixed root-cause/action taxonomies |

## Project structure

```
app/
  page.tsx                       Dashboard (client component)
  insights/, overview/            Recovery-rate analytics
  customers/, customers/[id]/     Customer scoring + detail
  escalations/                    Human escalation queue
  confirm/page.tsx                Email response landing page
  api/
    transactions/                 GET — current transaction state
    diagnose/                     POST — one-off LLM diagnosis call
    run-batch/ (+ progress/)      POST — the agent loop; GET — live progress polling
    razorpay/                     Order + Payment Link creation, webhook receiver
    escalations/, customers/,
    recovery-cases/, promises-to-pay/, webhook-events/
    reset/                        POST — restore data/transactions.json from seed

lib/
  types.ts                        Data model + every fixed taxonomy above
  diagnose.ts                     LLM call (Groq) + structured-output validation
  recovery-decision-engine.ts     The deterministic policy engine (~16 rules)
  agent.ts                        The core loop: diagnose → decide → execute → monitor
  agent-lock.ts                   Per-order lock — no double actions on one order
  razorpay.ts / razorpay-webhook.ts   Payment Links + verified, idempotent webhook handling
  email.ts                        Real transactional email via Brevo
  customer-scoring.ts             Transparent, weighted 0–100 customer risk scoring
  customer-recovery.ts            Aggregates recovery profiles from transaction history
  match-quality.ts                Well-matched-action logic, shared by agent + Insights
  escalation-queue.ts / escalation-actions.ts   Human queue + the 6 admin actions
  promise-to-pay.ts               Tracks a customer's committed pay-by date
  dashboard-analytics.ts          Money metrics, funnel, and rate breakdowns for Overview
  batch-progress.ts               In-memory progress counter behind the stepper UI

data/
  transactions.json               Current batch — mutated by every run, restorable via Reset
  transactions-seed.json           Pristine copy "Reset Demo Data" restores from
  customer-history.json           Permanent per-customer history — untouched by Reset
  escalation-queue.json, recovery-cases.json, webhook-events.json, ...
```

## Getting started

```bash
npm install
cp .env.local.example .env.local   # fill in the keys below
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables (`.env.local`)

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | LLM diagnosis calls (console.groq.com — free tier) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Test-mode orders + Payment Links — must be `rzp_test_` keys |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies incoming Razorpay webhook signatures — a separate secret, set in the Razorpay dashboard under Settings → Webhooks |
| `BREVO_API_KEY` / `BREVO_SENDER_EMAIL` | Real transactional email for the 3 real-customer transactions — sender must be verified in your Brevo account |
| `APP_BASE_URL` | Base URL used to build the `/confirm` response links inside recovery emails |

All keys are server-only — read inside `app/api/**` and `lib/**`, never exposed to the
client. `.env.local` is gitignored; never commit real keys.

If you want the real-customer flow to actually work end-to-end, edit `customerEmail` on
the relevant transactions in **both** `data/transactions.json` and
`data/transactions-seed.json` (the seed file is what "Reset Demo Data" restores from) —
the committed copies use a placeholder address.

## Design principle, restated

**AI recommends, policy engine decides.** Every recommendation the LLM makes is
non-binding until a separate, deterministic set of business rules validates it — and
both the raw recommendation and the validated decision are persisted, side by side, on
every single attempt. That's what makes the whole loop auditable, explainable, and safe
to run unattended.

A full narrated walkthrough (with an even deeper internal-working reference per system)
is in [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md); the original build spec is in
[`PROJECT_PLAN.md`](PROJECT_PLAN.md).
