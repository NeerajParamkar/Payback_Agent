import { NextRequest, NextResponse } from "next/server";
import { releaseLock, tryAcquireLock } from "@/lib/agent-lock";
import { buildEscalationAttempt } from "@/lib/escalation-queue";
import { syncEscalationEntryFor } from "@/lib/escalation-queue-store";
import { isOrderPaid } from "@/lib/payment-attempts";
import { syncRecoveryCaseFor } from "@/lib/recovery-case-store";
import { updateTransaction } from "@/lib/transactions-store";
import type { EscalationReason } from "@/lib/types";

// Sets a manually-reported escalation signal on a transaction - the entry
// point for the Human Escalation Queue triggers this system has no other way
// to observe (a support/ops agent reporting a dispute, an unverifiable "I
// already paid" claim, suspected fraud, or a complex issue). Setting any flag
// true freezes the order for human review immediately - it doesn't wait for
// the next automated run, since a manual report is already sufficient grounds
// on its own; no diagnosis is needed to act on it.
const FLAG_REASONS: Record<string, EscalationReason> = {
  customerDisputed: "customer_disputed_payment",
  customerClaimsPaidUnverified: "customer_claims_paid_unverified",
  suspectedFraud: "suspected_fraud",
  complexIssueFlag: "complex_refund_issue",
};

const FLAG_LABELS: Record<string, string> = {
  customerDisputed: "Customer disputed the payment",
  customerClaimsPaidUnverified: "Customer claims they already paid, but it can't be verified",
  suspectedFraud: "Suspected fraud / suspicious activity flagged",
  complexIssueFlag: "Complex refund/payment issue flagged",
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const flags = (body ?? {}) as Record<string, unknown>;
  const requestedFlags = Object.keys(FLAG_REASONS).filter((key) => flags[key] === true);

  if (requestedFlags.length === 0) {
    return NextResponse.json(
      {
        error: `At least one flag must be set to true: ${Object.keys(FLAG_REASONS).join(", ")}.`,
      },
      { status: 400 }
    );
  }

  if (!tryAcquireLock(id)) {
    return NextResponse.json(
      { error: "This transaction is currently being processed elsewhere; please try again in a moment." },
      { status: 409 }
    );
  }

  try {
    const updated = await updateTransaction(id, (current) => {
      const alreadyPaid = isOrderPaid(current);
      const reasons = requestedFlags.map((f) => FLAG_REASONS[f]);
      const labels = requestedFlags.map((f) => FLAG_LABELS[f]);
      const flagFields = Object.fromEntries(requestedFlags.map((f) => [f, true]));

      return {
        ...current,
        ...flagFields,
        // A dispute/fraud/unverified-claim report needs a human even on an
        // already-paid order (e.g. a dispute filed after the fact) - only skip
        // the freeze if the order is terminal in a way that's not worth
        // reopening (paid and no dispute-worthy flags... but every flag here
        // IS dispute-worthy, so always escalate).
        status: "escalated" as const,
        nextEligibleAttemptDate: undefined,
        pendingResponseToken: undefined,
        attempts: [
          ...current.attempts,
          buildEscalationAttempt(
            current,
            `Manually flagged: ${labels.join("; ")}.${alreadyPaid ? " (Order was already marked paid.)" : ""}`,
            reasons
          ),
        ],
      };
    });

    if (!updated) {
      return NextResponse.json({ error: `Transaction ${id} not found.` }, { status: 404 });
    }

    await syncRecoveryCaseFor(updated);
    await syncEscalationEntryFor(updated);

    return NextResponse.json({ ok: true, transaction: updated });
  } finally {
    releaseLock(id);
  }
}
