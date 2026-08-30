# Project: AI Revenue Recovery Agent (Razorpay Hackathon — Track 03)

## 1. Problem Statement (what this is solving)

Merchants lose revenue not in one clean step, but through a chain of small failures:
a payment fails, a customer abandons checkout, a subscription auto-debit bounces,
or a B2B invoice goes overdue. This money is not necessarily lost forever — with the
right diagnosis and the right follow-up action, a large chunk of it can be recovered.

Today this recovery process is manual (someone in finance/ops chases failed payments
by hand). We are building an **AI agent that automates this end-to-end**: it detects
at-risk revenue, diagnoses *why* the money didn't come in, decides the right recovery
action, executes it, tracks the outcome, and knows when to stop trying.

This is **Track 03: AI Revenue Recovery** of the Razorpay hackathon.

### The judging bar (must be satisfied)
1. Don't just detect the problem — actually execute a recovery action.
2. Report **measured money recovered** across a batch of transactions (not one cherry-picked example).
3. Recovery attempts must have **compliant escalation** (gradual, not spammy) and **stopping rules** (must not retry forever).
4. Full **audit trail** — every action taken must be logged with a reason, timestamp, and outcome.
5. Handle at least one failure case gracefully (case that could not be recovered, shown clearly, not hidden).

---

## 2. What We Are Building

A **single Next.js web application** (frontend + backend in one project) that:

1. Loads a synthetic dataset of ~40–50 fake transactions (payment failed / checkout
   abandoned / subscription failed / invoice overdue), each with a hidden "true reason"
   for the failure.
2. Runs an **agent loop** across every transaction:
   - **Detect** → flag transactions needing recovery.
   - **Diagnose** → call an LLM (Claude API) to infer the likely failure reason and
     recommend a recovery action, from a fixed set of reasons/actions (keeps it
     explainable, not open-ended free text).
   - **Execute** → simulate sending a reminder (SMS/WhatsApp/email — logged, not
     actually sent) OR trigger a real Razorpay test-mode order/payment retry via
     Razorpay's API.
   - **Simulate customer response** → weighted random logic decides if the "customer"
     pays after a given nudge (so we get a realistic, not 100%, recovery rate).
   - **Escalate or stop** → if not recovered, escalate to the next nudge (firmer
     message / incentive) up to a max number of attempts, then mark as "unrecovered."
3. Logs every single action taken per transaction (timestamp, action, reason, result)
   into an **audit trail**.
4. Displays a **dashboard**:
   - Headline numbers: Total ₹ at risk, Total ₹ recovered, Recovery rate %
   - A "Run Batch" button that runs the agent across all transactions live, updating
     the UI as it processes (so it's a satisfying live demo, not a static page load)
   - A table of all transactions with status (Recovered / Unrecovered / In Progress)
   - Click into any transaction to see its full audit trail (timeline of actions)
   - At least one transaction should end up "Unrecovered" and be clearly displayed —
     this is the required graceful-failure case, not something to hide.

This is a **demo-quality hackathon build** — the payment retry to Razorpay test API
should be real (to prove real integration), but reminders/SMS/WhatsApp/calls should be
**simulated and logged**, not actually sent through third-party messaging APIs (out of
scope, adds no judging value, burns time).

---

## 3. Tech Stack

- **Framework:** Next.js (App Router), TypeScript
- **Styling:** Tailwind CSS
- **UI components:** shadcn/ui (use Table, Card, Badge, Button, Dialog/Sheet components)
- **Backend:** Next.js API routes (`/app/api/**/route.ts`) — no separate backend server
- **Data storage:** Plain JSON file in `/data/transactions.json`, read/written by API
  routes (no database needed for this scale — keep it simple)
- **LLM:** Anthropic Claude API (`@anthropic-ai/sdk`), used for the diagnosis step.
  Force structured JSON output from the model (system prompt instructs it to return
  ONLY valid JSON matching a fixed schema — no prose).
- **Payments:** Razorpay Node SDK (`razorpay` npm package), Test Mode only
- **Env vars:** `.env.local` with `ANTHROPIC_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
  — these must NOT be hardcoded, and must NOT be exposed to the client/browser
  (only used inside `/app/api` route files, which run server-side only)
- **Hosting:** Deployable to Vercel with zero extra config (but local run with
  `npm run dev` is fine for the hackathon demo too)

---

## 4. Visual Design / Branding

The UI should visually resemble Razorpay's own product design language, since this is
a Razorpay hackathon project. Guidelines:

- **Primary brand color:** Razorpay blue — approximately `#0C2451` (dark navy) and
  `#3395FF` / `#528FF0` (bright blue accent) — use these as the primary/accent colors
  in the Tailwind theme config. If exact hex values are needed, pull the current
  official brand colors from Razorpay's public brand assets / website (razorpay.com)
  rather than guessing.
- **Background:** Clean white / very light gray (`#F9FAFB`) for main content areas,
  with the navy blue used for header bar, primary buttons, and key headline numbers.
- **Accent/success color:** Green for "Recovered" status badges.
- **Accent/failure color:** Red or amber for "Unrecovered" / failed status badges.
- **Typography:** Clean sans-serif (Inter or system-ui font stack), similar to
  Razorpay's own site — no decorative fonts.
- **Logo:** Add "Razorpay" wordmark/logo in the top navigation bar of the dashboard,
  next to a project title like "Revenue Recovery Agent". Do NOT generate or fabricate
  a logo image — instead fetch the official Razorpay logo SVG/PNG from Razorpay's
  public brand resources page (razorpay.com/newsroom/brand-assets or similar official
  source) and use that asset directly, or simply render the word "Razorpay" in their
  brand navy as styled text if fetching the official asset isn't feasible. This is a
  hackathon submission for Razorpay's own event, so referencing their brand this way
  is expected and appropriate — just don't invent a fake/modified logo.
- **Overall feel:** Should look like a clean fintech dashboard — think Stripe/Razorpay
  dashboard aesthetics: generous white space, card-based layout, subtle shadows,
  rounded corners (`rounded-lg` / `rounded-xl`), no clutter.

---

## 5. Data Model

### Transaction (synthetic seed data — generate ~40-50 of these)

```ts
type TransactionType = "payment_failed" | "checkout_abandoned" | "subscription_failed" | "invoice_overdue";

type FailureReason =
  | "card_expired"
  | "insufficient_funds"
  | "otp_timeout"
  | "bank_server_error"
  | "international_card_block"
  | "customer_distraction" // for checkout_abandoned
  | "payment_method_declined"
  | "invoice_not_reviewed"; // for invoice_overdue

interface Transaction {
  id: string;                 // e.g. "TXN-0001"
  customerName: string;
  amount: number;              // in INR
  type: TransactionType;
  trueFailureReason: FailureReason;  // hidden "ground truth" for simulation logic
  createdAt: string;           // ISO date
  status: "pending" | "recovered" | "unrecovered" | "in_progress";
  attempts: RecoveryAttempt[];
}

interface RecoveryAttempt {
  attemptNumber: number;
  timestamp: string;
  diagnosedReason: string;      // what the LLM diagnosed
  recommendedAction: string;    // what the LLM recommended
  actionTaken: string;          // e.g. "sent_sms_reminder", "razorpay_retry", "sent_incentive_offer"
  actionDetail: string;         // e.g. the actual message text, or Razorpay order id
  outcome: "paid" | "no_response" | "declined_again";
  razorpayOrderId?: string;     // only if a real Razorpay test order was created
}
```

### Fixed sets to keep things explainable (do not let the LLM invent new categories)

**Reasons (LLM must pick from this list):**
`card_expired, insufficient_funds, otp_timeout, bank_server_error, international_card_block, customer_distraction, payment_method_declined, invoice_not_reviewed`

**Recovery actions (LLM must pick from this list):**
`send_sms_reminder, send_whatsapp_reminder, send_email_reminder, retry_payment_same_method, retry_payment_alternate_method, offer_incentive_discount, escalate_to_call, escalate_to_account_manager, mark_unrecoverable`

---

## 6. Agent Logic (core loop)

For each transaction in the batch, run this loop (max 3 attempts per transaction):

1. **Diagnose** — call Claude API with the transaction details, asking it to return
   JSON: `{ reason: FailureReason, recommendedAction: string, customerMessage: string }`
   using ONLY the fixed lists above.
2. **Execute** —
   - If action is `retry_payment_same_method` or `retry_payment_alternate_method` →
     call Razorpay Test API to create a real test-mode order (this is the "real"
     integration part).
   - Otherwise → simulate the message (log it, display it in UI as if sent — no real
     SMS/WhatsApp/email is sent).
3. **Simulate outcome** — weighted random function decides paid / no_response /
   declined_again. Weight it so:
   - Better-matched actions (e.g., `retry_payment_alternate_method` for
     `international_card_block`) have a higher chance of success (~70%)
   - Generic/mismatched actions have lower chance (~30%)
   - This weighting is what makes the "AI diagnosis quality" visibly matter in the
     final recovery rate — a dumb agent would get a much lower overall recovery rate
     than a well-diagnosing one.
4. **Escalate or stop:**
   - If paid → mark transaction `recovered`, stop.
   - If no_response/declined and attempts < 3 → wait (simulated — no real delay
     needed, just increment attempt count) → escalate to next action (e.g., firmer
     message, add incentive) → repeat loop.
   - If attempts reach 3 → mark transaction `unrecovered`, stop. Log the final reason.
5. Log every step into `attempts[]` for that transaction — this becomes the audit
   trail shown in the UI.

**Compliance/stopping rules to hardcode (not LLM-decided):**
- Max 3 recovery attempts per transaction, no exceptions.
- No more than 1 attempt "per day" (simulate this with just attempt count, no real
  waiting needed for demo purposes).
- Once `mark_unrecoverable` is chosen or 3 attempts are exhausted, no further actions
  are taken — transaction is frozen in `unrecovered` state.

---

## 7. Pages / UI Structure

### `/` — Main Dashboard
- Top nav bar: Razorpay logo + "Revenue Recovery Agent" title, navy background
- Summary cards row: `Total At Risk (₹)`, `Total Recovered (₹)`, `Recovery Rate (%)`, `Cases Processed`
- Big "Run Batch" button — triggers `/api/run-batch`, shows a loading state, then
  live-updates the table below as results stream in (or just refresh table after
  completion if streaming is too complex for the time available — either is fine)
- Table of all transactions: ID, Customer, Amount, Type, Status (badge: green =
  recovered, red = unrecovered, gray = pending), Attempts count, "View Trail" button
- Clicking "View Trail" opens a side panel/modal showing that transaction's full
  `attempts[]` list as a timeline (timestamp → diagnosed reason → action taken →
  outcome)

### API Routes

- `POST /api/run-batch` — runs the full agent loop across all transactions in
  `/data/transactions.json`, updates their status/attempts, returns final results
- `POST /api/diagnose` — takes a transaction, calls Claude API, returns diagnosis JSON
  (called internally by run-batch, but expose as its own route for clarity/testability)
- `POST /api/razorpay/create-order` — creates a real Razorpay test-mode order for a
  given transaction amount, returns order id
- `GET /api/transactions` — returns current state of all transactions (for the
  dashboard to read/refresh)

---

## 8. Environment Setup Needed

Create a `.env.local` file with:

```
ANTHROPIC_API_KEY=your_key_here
RAZORPAY_KEY_ID=rzp_test_your_key_here
RAZORPAY_KEY_SECRET=your_secret_here
```

(Claude Code / the builder should NOT hardcode these anywhere, and should add
`.env.local` to `.gitignore`.)

---

## 9. Build Order (suggested sequence for Claude Code to follow)

1. Scaffold Next.js + TypeScript + Tailwind + shadcn/ui project
2. Set up Razorpay brand color theme in `tailwind.config.ts`
3. Generate the synthetic dataset (~40-50 transactions) into `/data/transactions.json`
   using the data model above — make sure it's realistic and varied across all 4
   transaction types and all failure reasons
4. Build `/api/diagnose` (Claude API call with structured JSON output)
5. Build `/api/razorpay/create-order` (Razorpay test-mode SDK call)
6. Build the core agent loop logic (`/lib/agent.ts`) implementing section 6 above
7. Build `/api/run-batch` to orchestrate the loop across all transactions
8. Build the dashboard UI (`/app/page.tsx`) — summary cards, run button, table
9. Build the transaction detail/audit-trail view (modal or side panel)
10. Test end-to-end: run the batch, confirm realistic mixed results (some recovered,
    some not), confirm audit trail displays correctly, confirm at least one Razorpay
    test order was actually created (verify in Razorpay test dashboard)
11. Polish styling to match Razorpay brand look and feel
12. Add loading states / empty states / basic error handling so nothing crashes if
    an API call fails mid-demo

---

## 10. What Success Looks Like (for the demo)

Clicking "Run Batch" processes ~40-50 transactions live, and the dashboard ends up
showing something like:

> **Total At Risk: ₹1,84,500 | Recovered: ₹1,21,300 (65.8%) | Cases: 47**

...with a full clickable audit trail per transaction, a visibly handled unrecovered
case, and at least one transaction whose recovery attempt involved a real Razorpay
test-mode API call (verifiable in the Razorpay test dashboard's Orders section).
