# Demo Video Script — AI Revenue Recovery Agent

A 5–7 minute walkthrough script for demoing this project, plus a full
internal-working reference for every major system so you can answer any
follow-up question on the spot.

**How to use this doc:**
- **[SAY]** blocks are the actual narration — read them close to verbatim,
  they're paced to land around 5:30–7:00 total at a natural speaking pace
  (~150 words/minute).
- **[SHOW]** blocks tell you exactly what to click, in order.
- **Internal working** blocks are *not* meant to be spoken in full — they're
  your own reference, for the 1–2 sentence technical aside when you want one,
  or for Q&A afterward. Say as much or as little of it as time allows.
- Total spoken script: ~1,000 words ≈ 6:40 at 150 wpm, with room to breathe.

---

## Timing budget

| Segment | Time | Duration |
|---|---|---|
| 1. Intro — the problem | 0:00–0:30 | 30s |
| 2. Dashboard — Current Records | 0:30–1:15 | 45s |
| 3. Run Batch — live agent run | 1:15–2:45 | 90s |
| 4. Previous Records | 2:45–3:20 | 35s |
| 5. Customers + customer detail | 3:20–4:10 | 50s |
| 6. Insights + Overview | 4:10–5:00 | 50s |
| 7. Escalations queue | 5:00–5:40 | 40s |
| 8. Real customer flow | 5:40–6:15 | 35s |
| 9. Architecture recap + close | 6:15–7:00 | 45s |

---

## 1. Intro — the problem (0:00–0:30)

**[SHOW]** Dashboard (`/`), Current Records tab, sitting idle before any run.

**[SAY]**
> "Every merchant loses revenue the same quiet way — a card gets declined, a
> customer abandons checkout, a subscription auto-debit bounces, an invoice
> goes overdue. None of that is one dramatic failure, it's dozens of small
> ones a day, and most teams just don't have the bandwidth to chase each one
> down. This is an AI agent that does that chasing automatically — it scans
> at-risk transactions, diagnoses *why* each one failed, decides the right
> next move, executes it for real, and only pulls in a human when the case
> genuinely needs one."

**Internal working:**
- The dataset (`data/transactions.json`) models 4 failure types:
  `payment_failed`, `checkout_abandoned`, `subscription_failed`, `invoice_overdue`.
- 25 of 28 transactions are fully synthetic; 3 (`TXN-0002`, `TXN-0004`,
  `TXN-0008`) carry a real email and go through a genuine Brevo email +
  Razorpay Payment Link flow — see segment 8.
- `trueFailureReason` on each transaction is hidden simulation ground truth
  — the AI never sees it. Diagnosis is genuinely blind, which is what makes
  the recovery rate a real signal of diagnosis quality, not a scripted number.

---

## 2. Dashboard — Current Records (0:30–1:15)

**[SHOW]** Point out the 5 stat cards, then the transactions table — the
Find box, the date range, the sortable "Created" column.

**[SAY]**
> "This is the live dashboard. Total At Risk, Total Recovered, what's still
> Remaining, the Recovery Rate, and how many cases are in play — right now
> everything's sitting at pending, nothing's been touched. Below that is
> every current transaction, and it's fully searchable — I can find a
> customer by name, or narrow the whole table to a date range. And this
> isn't just a display filter — if I narrow this down and hit Run Batch, the
> agent only analyses what's actually on screen. Nothing invisible happens
> outside what you can see and reason about."

**Internal working:**
- `app/page.tsx` computes `sortedTransactions` — filter (search + date
  range) and sort combined into one derivation, recomputed on render (small
  dataset, so no memoization needed).
- "Select all" scopes to the currently *visible* rows, not the full set.
- If a filter is active and nothing's manually checked, the Run Batch
  button relabels to **"Run Filtered (N)"** and `handleRunBatch` sends only
  those transaction IDs to `POST /api/run-batch`.
- The 5th stat, **Remaining**, is `Total At Risk − Total Recovered` —
  added specifically so the three numbers always reconcile at a glance.

---

## 3. Run Batch — live agent run (1:15–2:45)

**[SHOW]** Click **Run Batch**. Let the stage stepper visibly progress
through a few stages, then cut to (or fast-forward to) the completed
**Agent Run Report**.

**[SAY]**
> "Watch what happens when I click Run Batch. This isn't a black box — you
> can see exactly what stage the agent is in: it scans transactions, finds
> what's at risk, pulls each customer's history, calculates recovery scores,
> finds root causes, picks a strategy, executes it, and monitors payments.
> Under the hood, every single transaction goes through the same pipeline:
> an LLM diagnoses the likely root cause — bank decline, insufficient
> funds, checkout abandonment, whatever the evidence actually supports — and
> recommends one action. But the AI never touches money or sends anything
> directly. A separate, fully deterministic policy engine validates that
> recommendation against real business rules — retry limits, reminder caps,
> high-value thresholds, even a spike check against *that specific
> customer's* own spending pattern — before anything executes. When it's
> done, you get a full report: transactions analysed, revenue at risk,
> cases created, actions actually executed, human escalations, revenue
> recovered, and the recovery rate."

**Internal working — the pipeline, file by file:**
- **`lib/batch-progress.ts`** — the 9 named stages
  (`scanning → finding_revenue_at_risk → analysing_customer_history →
  calculating_scores → finding_root_causes → selecting_strategies →
  executing_actions → monitoring_payments → completed`) shown in the
  stepper. First three are genuine one-time boundaries; the middle four are
  driven by real completion-fraction of the concurrent worker pool, not a
  fake timer.
- **`lib/diagnose.ts`** — calls Groq (`openai/gpt-oss-20b`), constrained by
  a Zod schema to a fixed 12-value root-cause taxonomy. Fed the
  transaction's `gatewayErrorHint` (a realistic gateway-style error string)
  plus, on a retry, any *real* Razorpay webhook-reported failure reason for
  that order — this is what lets it return a specific, high-confidence
  cause instead of defaulting to `unknown`.
- **`lib/recovery-decision-engine.ts`** — ~16 deterministic rules run in
  order. Highlights: order-already-paid → stop; retry limit exceeded →
  escalate; customer opted out → stop; high-value order (flat ₹10,000
  threshold) → escalate; **`unusual_amount_spike`** — amount ≥5x this
  specific customer's own historical average → escalate, even if it's under
  the flat threshold; reminder/payment-link caps; no duplicate Payment
  Links (resends the existing one instead); low first-attempt confidence →
  wait rather than spend a real financial operation blind.
- **`lib/agent.ts`** — `runAgentForTransactionLocked` runs diagnose →
  decide → execute exactly once per call, always pauses afterward (a
  per-cause cooldown table), and is wrapped in a per-order lock
  (`lib/agent-lock.ts`) so two overlapping runs can never double up a
  reminder or a Payment Link on the same order.
- **`app/api/run-batch/route.ts`** — orchestrates this across 5 concurrent
  workers, then finalizes Recovery Cases, Escalation Queue entries, and
  Promise-to-Pay records for whatever the run touched, and returns the
  summary by diffing pre-run vs. post-run state (so "cases created" means
  genuinely new, not the whole book).

---

## 4. Previous Records (2:45–3:20)

**[SHOW]** Click the **Previous Records** tab.

**[SAY]**
> "Right next to that is Previous Records — this is permanent history, one
> past resolved transaction per customer, and it's what gives the agent's
> scoring an actual track record to work from instead of guessing blind.
> You can see the base recovery rate, how many attempts and how long it
> typically takes to actually collect payment, and which channel — payment
> link or reminder — tends to close the deal. And unlike the current batch,
> this doesn't reset when you hit Reset Demo Data. It's meant to persist."

**Internal working:**
- `data/customer-history.json`, read via `lib/customer-history-store.ts` —
  deliberately a separate file from `transactions.json`, so `POST
  /api/reset` never touches it, and it never pollutes the operational
  Dashboard/Insights/Overview numbers (which should only reflect the
  *current* batch).
- Generated with real variety: 8 recovered via payment link, 8 via
  reminder, 6 recovered on a second attempt, 6 never recovered — not
  cloned data.
- Feeds three things: the Customers page profiles, the customer detail
  page's transaction history, and — critically — `run-batch`'s
  `customerHistory` context passed into every diagnosis call, including the
  `averagePastAmount` the spike-detection rule (segment 3) compares against.

---

## 5. Customers + customer detail (3:20–4:10)

**[SHOW]** Go to `/customers`, then click into one customer.

**[SAY]**
> "The Customers page scores every customer 0 to 100 — not a black-box
> number, a fully transparent weighted model: payment success rate, past
> recovery success, response to reminders, how fast they typically pay, and
> more. Click into anyone and you get their full story — a risk label, the
> complete score breakdown with exactly how many points each factor
> contributed, and every transaction they've ever had, when it failed and
> when it actually got paid. This is the same data the agent itself reads
> before it ever decides how to approach them."

**Internal working:**
- `lib/customer-scoring.ts`'s `RuleBasedCustomerScorer` — 7 factors, weights
  sum to 1.0 (payment success rate 25%, previous recovery success 20%,
  response to reminders 10%, failed-payment frequency 15%, average payment
  delay 10%, payment-link conversion 15%, attempts-to-recover 5%). A factor
  with no history defaults to a neutral 0.5, never penalizing a new
  customer. Explicitly built behind a `CustomerScorer` interface so it can
  be swapped for a real ML model later without touching any caller.
  Risk label: ≥70 low, 40–69 medium, <40 high.
- `lib/customer-recovery.ts`'s `customerIdentityKey` groups by
  name+email composite, not email alone (several placeholder-email
  transactions in this dataset would otherwise wrongly merge into one
  person).
- `app/customers/[customerId]/page.tsx` + `app/api/customers/[customerId]/route.ts`
  — combines live + permanent history transactions for that one customer.

---

## 6. Insights + Overview (4:10–5:00)

**[SHOW]** `/insights`, then `/overview`.

**[SAY]**
> "Two more analytics views. Insights breaks recovery rate down by root
> cause, by action taken, and specifically validates that the AI's diagnosis
> quality actually matters — well-matched actions convert meaningfully
> better than generic ones, which is the whole premise proven with real
> numbers. Overview is the executive dashboard — money-first metrics, a full
> recovery funnel from failed payment through to revenue recovered, and
> breakdowns by root cause, channel, customer segment, amount tier, time of
> day, and attempt number."

**Internal working:**
- `lib/match-quality.ts` — a small, deliberately server-dependency-free
  module (no `fs` imports) shared between the live agent loop and the
  Insights client component, defining what counts as a "well-matched"
  action for a given root cause.
- `lib/dashboard-analytics.ts`'s `buildDashboardAnalytics` — pure function,
  computes money metrics, a 7-stage funnel, and 6 rate breakdowns from
  transactions/cases/escalations. Feeds the Overview page only — it
  deliberately does **not** include Previous Records history, so the
  headline money metrics stay scoped to the current batch.

---

## 7. Escalations queue (5:00–5:40)

**[SHOW]** `/escalations`, click into one entry.

**[SAY]**
> "Not everything should be automated, and this is where the agent hands
> off. An order escalates automatically for specific, named reasons — a
> high-value threshold, a confidence that's still low after multiple
> attempts, a duplicate payment, a suspicious amount spike for that
> customer — and once it's here, automation stops completely, permanently,
> until a human acts. From here an admin can take ownership, send a fresh
> payment link, record an offline payment, mark it recovered, or stop
> recovery outright — every action fully audit-trailed."

**Internal working:**
- `lib/escalation-queue.ts`'s `deriveEscalationEntry` — an entry exists only
  while `transaction.status === "escalated"`; once escalated,
  `runAgentForTransactionLocked` returns immediately unchanged (checked
  first, before any diagnosis call) — permanently, until an admin action
  moves it.
- `lib/escalation-actions.ts` — all 6 admin actions are lock-protected
  (same `lib/agent-lock.ts` the automated loop uses) so an admin action can
  never race a concurrent batch run or webhook on the same order.
- 10 named escalation reasons total (`lib/types.ts`'s `EscalationReason`),
  rendered generically via `humanize()` — no per-reason UI code needed when
  a new one's added.

---

## 8. Real customer flow (5:40–6:15)

**[SHOW]** Open the trail for `TXN-0004` (or any of the 3 real-customer
transactions) if it's reached `waiting_for_response`.

**[SAY]**
> "Three transactions in this dataset are wired to a real inbox, to prove
> the end-to-end flow actually works, not just the simulation. When one of
> these needs a retry, the agent creates a genuine, payable Razorpay
> test-mode Payment Link and emails it for real — Yes I've paid, No not
> yet, or I paid another way. And when a real payment actually comes
> through, a signature-verified Razorpay webhook confirms it — idempotent,
> so a redelivered event is safely recognized and skipped, and it's the
> authoritative source of truth regardless of what the automated loop
> otherwise assumed."

**Internal working:**
- `lib/email.ts` — real Brevo transactional email; `lib/razorpay.ts` — real
  test-mode Payment Link creation (`lib/razorpay.ts` hard-refuses to run
  against anything but an `rzp_test_` key).
- `lib/razorpay-webhook.ts`'s `processRazorpayWebhookEvent` — idempotency
  key is `<event type>:<entity id>`, checked against
  `data/webhook-events.json` before anything is mutated. Duplicate-payment
  detection (two different real payments on one order) escalates rather
  than silently double-counting.
- `app/confirm/page.tsx` + `handleEmailResponse` in `lib/agent.ts` — the
  customer's own click is a self-report, kept deliberately separate from
  the admin-verified `lib/manual-payment-actions.ts` module.

---

## 9. Architecture recap + close (6:15–7:00)

**[SHOW]** Back to the Dashboard, both tabs briefly.

**[SAY]**
> "The one principle underneath all of this: the AI only ever *recommends*.
> It never touches money or sends anything directly — every recommendation
> passes through a separate, fully deterministic policy engine that decides
> what's actually allowed, and everything it does is logged into a complete
> audit trail, attempt by attempt. That's what makes this safe to run
> unattended — it's not one model making financial decisions, it's an AI
> generating a recommendation, and hard business rules deciding whether to
> trust it. Scan, diagnose, decide, act, monitor, escalate what needs a
> human — that's the whole loop, and you just watched it happen live."

**Internal working:**
- This AI-recommends / policy-engine-decides split is the single
  architectural decision the entire system hangs off — see
  `lib/recovery-decision-engine.ts`'s file header for the explicit
  rationale, and `RecoveryAttempt.decisionAction` vs. `recommendedAction`
  in `lib/types.ts` for how both are separately persisted per attempt
  (never conflated) as the audit trail.

---

## Appendix: full internal-working reference by system

Deeper reference beyond what fits in the 7-minute cut — useful if a demo
runs into Q&A, or for a longer recorded walkthrough.

### The recovery loop (`lib/agent.ts`)
`runAgentForTransactionLocked` — for one transaction, one cycle:
1. Guards: order already paid (`isOrderPaid`, source of truth is
   `PaymentAttempt.status === "captured"`) → stop. Frozen states
   (recovered/unrecovered/escalated/max-attempts/waiting-for-response/
   awaiting-payment/still-cooling-down) → return unchanged.
2. `diagnoseTransaction()` — AI call, structured output, never executes
   anything itself.
3. `decideRecoveryAction()` — deterministic validation (see below).
4. Branch on the validated `DecisionAction`: `wait`/`track_promise_to_pay`
   → freeze + schedule, no operation. `stop` → freeze unrecovered.
   `escalate_to_human` → freeze escalated, never reaches execution.
   Otherwise → `executeAction()`, the *only* place a real financial
   operation happens (`generate_payment_link`).
5. Real customer (`customerEmail` set) → real email, freeze
   `waiting_for_response`, stop entirely until they click. Otherwise → a
   weighted simulated outcome (`lib/match-quality.ts`'s well-matched-action
   logic drives the odds).
6. Resolve the payment attempt, schedule the next cooldown, `break` — never
   fires two actions back-to-back in one call.

### Recovery Decision Engine rules (`lib/recovery-decision-engine.ts`)
In evaluation order (roughly): manual flags always win → order already paid
→ retry limit exceeded → customer opted out → high-value threshold (first
attempt only) → **amount spike vs. this customer's own average** (first
attempt only, independent of the flat threshold) → low confidence beyond
first attempt → reject a premature AI give-up if recovery probability still
looks reasonable → reminder cap → payment-link retry cap → no duplicate
Payment Link (resend instead) → amount floor for minting a real link → low
first-attempt confidence defers a real link → poor customer track record
defers a first link → respect a recent "not yet" (track as promise instead
of re-prompting) → no repeating the same ineffective action → max recovery
duration exceeded. Every rule pushes a `PolicyCheckResult` for transparency,
even when it passes.

### Human Escalation Queue (`lib/escalation-queue.ts`, `escalation-actions.ts`)
Entry exists only while `status === "escalated"`; derived, not
independently mutable except for ownership/resolution. 6 admin actions:
resolve, stop recovery, mark recovered, record offline payment, send
payment link, take ownership — all except take-ownership mutate the
transaction through the same lock-protected primitives the automated loop
uses.

### Promise-to-Pay (`lib/promise-to-pay.ts`)
One current record per order. Created either by the Decision Engine's
`track_promise_to_pay` action or by an admin recording a customer-stated
date. Resolves to `kept` (paid before the deadline) or `broken` (deadline
passed, still unpaid) the next time anything touches that transaction — no
background scheduler, so a promise can sit visibly pending past its
deadline until the next batch run or webhook.

### Webhook processing (`lib/razorpay-webhook.ts`)
Idempotent (checked against a persisted log before any mutation), secure
(signature verified before the payload is even parsed), retry-safe (a
lock-contended delivery returns `"retry"`, mapped to a 5xx so Razorpay
redelivers), logged (every delivery — processed, duplicate, ignored, or
errored). Handles success, failure, pending (authorized-not-captured), and
refund (which reopens the order if it leaves it no longer paid).

### Customer scoring (`lib/customer-scoring.ts`, `customer-recovery.ts`)
`CustomerScorer` interface with one implementation today
(`RuleBasedCustomerScorer`) — swappable for an ML model later without
touching any caller. `buildCustomerRecoveryProfiles` aggregates purely from
transaction history at read time — no separate persisted profile that can
drift.

### Concurrency safety (`lib/agent-lock.ts`, `lib/batch-progress.ts`)
Per-order in-memory lock, acquired by every write path that can touch a
transaction (the agent loop, email responses, webhooks, and every admin
action) — the concrete guarantee that two overlapping operations can never
double up a reminder or a Payment Link on the same order. Batch progress is
a simple in-memory counter with a named current stage, polled by the
dashboard every 600ms.
