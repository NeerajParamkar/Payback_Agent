import Groq from "groq-sdk";
import { z } from "zod";
import {
  RECOVERY_ACTIONS,
  ROOT_CAUSES,
  type Confidence,
  type RecoveryAction,
  type RecoveryPriority,
  type RootCause,
  type TransactionType,
} from "@/lib/types";

const CONFIDENCE_LEVELS: Confidence[] = ["low", "medium", "high"];
const PRIORITY_LEVELS: RecoveryPriority[] = ["low", "medium", "high", "critical"];

const DiagnosisSchema = z.object({
  rootCause: z.enum(ROOT_CAUSES as [RootCause, ...RootCause[]]),
  confidence: z.enum(CONFIDENCE_LEVELS as [Confidence, ...Confidence[]]),
  recoveryProbability: z.number().min(0).max(1),
  priority: z.enum(PRIORITY_LEVELS as [RecoveryPriority, ...RecoveryPriority[]]),
  recommendedAction: z.enum(
    RECOVERY_ACTIONS as [RecoveryAction, ...RecoveryAction[]]
  ),
  reason: z.string().min(1), // internal rationale - never shown to the customer
  customerMessage: z.string().min(1),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

// Lightweight projection of a CustomerRecoveryProfile (lib/customer-recovery.ts)
// fed into the prompt - just the counts/signal relevant to diagnosing one order,
// not the full profile (amounts, recoveryScore, scoreBreakdown aren't useful here
// and would just add noise to the prompt).
export interface CustomerHistoryContext {
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  previousRecoveryAttempts: number;
  successfulRecoveryActions: number;
  failedRecoveryActions: number;
  preferredRecoveryChannel: string | null;
  // This customer's own average transaction amount across their PAST
  // (already-resolved) history only - never includes the transaction
  // currently being diagnosed. null when there's no history yet. Lets the
  // Recovery Decision Engine (lib/recovery-decision-engine.ts) catch a
  // sudden spike relative to this specific customer's normal pattern, which
  // a flat high-value threshold alone would miss for anyone whose typical
  // spend sits well under it.
  averagePastAmount: number | null;
}

export interface DiagnoseInput {
  id: string;
  type: TransactionType;
  amount: number;
  customerName: string;
  attemptNumber?: number; // 1-indexed; defaults to 1
  previousActions?: RecoveryAction[]; // actions already tried this transaction, without success
  customerHistory?: CustomerHistoryContext; // this customer's pattern across ALL their transactions
  gatewayErrorHint?: string; // the ORIGINAL failure's gateway-reported error text, if any - see Transaction.gatewayErrorHint
  latestGatewayFailureReason?: string; // a REAL Razorpay-reported failure reason from this order's own most recent payment attempt, if this is a retry that itself failed at the gateway
}

const SYSTEM_PROMPT = `You are the diagnosis engine for an AI revenue recovery agent used by a fintech merchant platform.

Given metadata about one failed or at-risk transaction - and, when provided, the customer's recovery history across all their OTHER transactions - analyze it and return a single JSON object with exactly these keys:

{"rootCause": "<one value from the list below>", "confidence": "<low|medium|high>", "recoveryProbability": <number 0-1>, "priority": "<low|medium|high|critical>", "recommendedAction": "<one value from the fixed action list>", "reason": "<1-2 sentence internal rationale, NOT shown to the customer>", "customerMessage": "<short, polite, realistic customer-facing message, 1-2 sentences>"}

ROOT CAUSE - choose EXACTLY ONE value from this fixed list, do not invent new categories: ${ROOT_CAUSES.join(", ")}.
- bank_decline: the issuing bank explicitly declined the transaction
- network_failure: a transient network/gateway/bank-server error, not a real decline
- insufficient_funds: the account likely didn't have enough balance
- card_failure: the card itself is the problem (expired, blocked, damaged)
- upi_failure: a UPI-specific failure (app timeout, wrong PIN, handle issue)
- authentication_failure: OTP/3DS/authentication step failed or timed out
- checkout_abandonment: the customer likely just didn't complete checkout, no clear payment error
- payment_pending: the payment appears genuinely still in progress, not failed
- repeated_payment_failure: this customer has a clear pattern of repeated failures (use the customer history)
- overdue_payment: a B2B invoice or subscription payment simply gone unpaid past its due date
- payment_order_mismatch: the order and payment records don't line up (e.g. amount mismatch)
- unknown: the available data does not clearly support any specific cause above

GATEWAY ERROR, when given below, is real (or realistically simulated) evidence from the payment gateway - not a guess. When it clearly points to one cause (e.g. an explicit reason code, "insufficient funds", "card expired", "authentication failed"), use it and raise your confidence accordingly - don't default to "unknown" when real evidence is right in front of you. When it's genuinely generic (e.g. a bare "declined, no further reason given"), it still supports "bank_decline" specifically (the bank did decline it, that much is known) even without a more precise code - "unknown" is for when there is truly no signal at all, not merely an imprecise one.

Be honest about uncertainty. If the transaction's type, amount, gateway error, and history don't give a clear signal for a specific root cause, choose "unknown" and set confidence to "low" - do NOT force-fit a specific-sounding cause you can't actually support from the data given. Never invent specifics you weren't given (e.g. a bank name, a card network, an exact error code) beyond what the gateway error itself already states.

CONFIDENCE reflects how well the available data supports your rootCause choice - "high" only when the signal is genuinely clear, "low" whenever you are effectively guessing.

RECOVERY PROBABILITY is your own estimate, 0 to 1, of how likely this specific transaction is to actually be recovered, given the root cause, the recommended action, and the customer's history.

PRIORITY is how urgently this case needs attention - weigh the amount at risk, how many attempts on this order have already failed, and any repeated-failure pattern in the customer's history.

RECOMMENDED ACTION - choose EXACTLY ONE value from this fixed list: ${RECOVERY_ACTIONS.join(", ")}.

CUSTOMER HISTORY, when given below, reflects this same customer's pattern across ALL their transactions, not just this one. Use it to inform rootCause (especially repeated_payment_failure - a customer with several past failures deserves this label even if this specific attempt looks like a one-off), confidence, recoveryProbability, priority, and prefer a channel that has worked for them before when relevant.

This may be a retry on a transaction where earlier attempts on THIS order already failed. When previous attempts are listed: escalate - pick a different, firmer action than what was already tried, and make the customer message more urgent in tone. Only recommend mark_unrecoverable when this is the last attempt and recovery genuinely seems unlikely.

Respond with ONLY a single valid JSON object - no markdown code fences, no prose before or after it.`;

function getClient(): Groq {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to .env.local (see .env.local.example)."
    );
  }
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

// Groq's free/on-demand tier caps tokens-per-minute per org (shared across all
// models), so bursts of concurrent diagnose calls occasionally hit a 429. Retry
// those with the server-reported backoff instead of failing the attempt outright.
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_RETRY_DELAY_MS = 10_000;

function parseRetryDelayMs(message: string): number | null {
  const match = message.match(/try again in ([\d.]+)(ms|s)\b/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const ms = match[2] === "ms" ? value : value * 1000;
  return Number.isFinite(ms) ? ms : null;
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error instanceof Groq.RateLimitError;
      if (!isRateLimit || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }
      const delay = Math.min(
        parseRetryDelayMs(error.message) ?? 2000 * (attempt + 1),
        MAX_RETRY_DELAY_MS
      );
      await new Promise((resolve) => setTimeout(resolve, delay + 250));
    }
  }
}

function formatCustomerHistory(history: CustomerHistoryContext): string {
  const channelLine = history.preferredRecoveryChannel
    ? ` Channel that has worked for them before: ${history.preferredRecoveryChannel}.`
    : "";
  const avgAmountLine =
    history.averagePastAmount !== null
      ? ` This customer's average past transaction was ₹${Math.round(history.averagePastAmount)}.`
      : "";
  return `\nCustomer history across all their transactions: ${history.totalTransactions} total, ${history.successfulTransactions} successful, ${history.failedTransactions} failed. ${history.previousRecoveryAttempts} previous recovery attempts (${history.successfulRecoveryActions} successful, ${history.failedRecoveryActions} failed).${channelLine}${avgAmountLine}`;
}

export async function diagnoseTransaction(
  input: DiagnoseInput
): Promise<Diagnosis> {
  const { id, type, amount, customerName } = input;
  const attemptNumber = input.attemptNumber ?? 1;
  const previousActions = input.previousActions ?? [];
  const client = getClient();

  const previousActionsLine =
    previousActions.length > 0
      ? `\nPrevious attempt(s) already tried without success: ${previousActions.join(", ")}.`
      : "";
  const customerHistoryLine = input.customerHistory
    ? formatCustomerHistory(input.customerHistory)
    : "";
  const gatewayErrorLine = input.gatewayErrorHint
    ? `\nGateway error at original failure: ${input.gatewayErrorHint}`
    : "";
  const latestGatewayFailureLine = input.latestGatewayFailureReason
    ? `\nGateway error on the most recent retry attempt: ${input.latestGatewayFailureReason}`
    : "";

  const completion = await withRateLimitRetry(() =>
    client.chat.completions.create({
      model: "openai/gpt-oss-20b",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Transaction ${id}
Customer: ${customerName}
Type: ${type}
Amount: ₹${amount}
Attempt: ${attemptNumber} of 3${gatewayErrorLine}${latestGatewayFailureLine}${previousActionsLine}${customerHistoryLine}

Diagnose the root cause and recommend one recovery action.`,
        },
      ],
    })
  );

  const text = completion.choices[0]?.message?.content;
  if (!text) {
    throw new Error(
      `Diagnosis failed for ${id}: model returned an empty response.`
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new Error(
      `Diagnosis failed for ${id}: model did not return valid JSON.`
    );
  }

  const parsed = DiagnosisSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Diagnosis failed for ${id}: model output did not match the required schema.`
    );
  }

  return parsed.data;
}
