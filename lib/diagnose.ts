import Groq from "groq-sdk";
import { z } from "zod";
import {
  FAILURE_REASONS,
  RECOVERY_ACTIONS,
  type FailureReason,
  type RecoveryAction,
  type TransactionType,
} from "@/lib/types";

const DiagnosisSchema = z.object({
  reason: z.enum(FAILURE_REASONS as [FailureReason, ...FailureReason[]]),
  recommendedAction: z.enum(
    RECOVERY_ACTIONS as [RecoveryAction, ...RecoveryAction[]]
  ),
  customerMessage: z.string().min(1),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export interface DiagnoseInput {
  id: string;
  type: TransactionType;
  amount: number;
  customerName: string;
  attemptNumber?: number; // 1-indexed; defaults to 1
  previousActions?: RecoveryAction[]; // actions already tried this transaction, without success
}

const SYSTEM_PROMPT = `You are the diagnosis engine for an AI revenue recovery agent used by a fintech merchant platform.

Given metadata about one failed or at-risk transaction, do two things:
1. Diagnose the single most likely reason the transaction failed or is at risk, choosing EXACTLY ONE value from this fixed list (do not invent new categories): ${FAILURE_REASONS.join(", ")}.
2. Recommend the single best recovery action for that reason, choosing EXACTLY ONE value from this fixed list: ${RECOVERY_ACTIONS.join(", ")}.

Also write a short, polite, realistic customer-facing message (1-2 sentences) matching the recommended action - this is what would be sent to the customer as an SMS/WhatsApp/email reminder or incentive offer. Do not mention the internal failure-reason category by name.

Use these patterns as a guide for which reasons are typical per transaction type:
- payment_failed / subscription_failed: card and bank-side issues (card_expired, insufficient_funds, otp_timeout, bank_server_error, international_card_block, payment_method_declined) are most likely.
- checkout_abandoned: customer_distraction is most likely, though otp_timeout or payment_method_declined are possible.
- invoice_overdue: invoice_not_reviewed is most likely for B2B invoices, though insufficient_funds or payment_method_declined are possible.

This may be a retry on a transaction where earlier recovery attempts already failed. When previous attempts are listed: escalate — pick a different, firmer action than what was already tried (e.g. move from a reminder to an incentive offer, or from an incentive to escalate_to_call / escalate_to_account_manager), and make the customer message more urgent in tone. Only recommend mark_unrecoverable when this is the last attempt and recovery genuinely seems unlikely.

Respond with ONLY a single valid JSON object - no markdown code fences, no prose before or after it - with exactly these three keys:
{"reason": "<one of the fixed reasons above>", "recommendedAction": "<one of the fixed actions above>", "customerMessage": "<short customer-facing message>"}`;

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
Attempt: ${attemptNumber} of 3${previousActionsLine}

Diagnose the most likely failure reason and recommend one recovery action.`,
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
