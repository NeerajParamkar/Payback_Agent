import { NextRequest, NextResponse } from "next/server";
import { releaseLock, tryAcquireLock } from "@/lib/agent-lock";
import { buildAdminAttempt } from "@/lib/manual-payment-actions";
import { resolveEscalationForTransaction } from "@/lib/escalation-queue-store";
import { buildAdminRecordedPromise } from "@/lib/promise-to-pay";
import { readPromisesToPay, recordPromiseToPay } from "@/lib/promise-to-pay-store";
import { syncRecoveryCaseFor } from "@/lib/recovery-case-store";
import { updateTransaction } from "@/lib/transactions-store";

// Admin records a customer's stated promise to pay ("I will pay tomorrow") -
// see lib/promise-to-pay.ts for how it's tracked and resolved. Freezes the
// order (status "promise_to_pay") until the promised time, exactly like an
// automated one, but with a real customer-stated date (and, optionally, time)
// instead of an inferred wait.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

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

  const { promiseDate, promiseTime, adminName, note } = (body ?? {}) as Record<string, unknown>;

  if (typeof promiseDate !== "string" || !DATE_RE.test(promiseDate)) {
    return NextResponse.json(
      { error: '"promiseDate" is required and must be in YYYY-MM-DD format.' },
      { status: 400 }
    );
  }
  if (promiseTime !== undefined && (typeof promiseTime !== "string" || !TIME_RE.test(promiseTime))) {
    return NextResponse.json(
      { error: '"promiseTime" must be in HH:MM (24-hour) format if provided.' },
      { status: 400 }
    );
  }

  const timeProvided = typeof promiseTime === "string";
  // No specific time given -> treat the promise as due by end of that day.
  const promiseAt = new Date(`${promiseDate}T${timeProvided ? promiseTime : "23:59"}:00`);
  if (Number.isNaN(promiseAt.getTime())) {
    return NextResponse.json(
      { error: "promiseDate/promiseTime do not form a valid date." },
      { status: 400 }
    );
  }

  const resolvedAdminName = typeof adminName === "string" && adminName.trim() ? adminName : "Admin";
  const noteText = typeof note === "string" && note.trim() ? note : undefined;
  const promiseAtIso = promiseAt.toISOString();

  if (!tryAcquireLock(id)) {
    return NextResponse.json(
      { error: "This transaction is currently being processed elsewhere; please try again in a moment." },
      { status: 409 }
    );
  }

  try {
    const updated = await updateTransaction(id, (current) => ({
      ...current,
      status: "promise_to_pay" as const,
      nextEligibleAttemptDate: promiseAtIso,
      pendingResponseToken: undefined,
      attempts: [
        ...current.attempts,
        buildAdminAttempt(
          current,
          "admin_recorded_promise_to_pay",
          noteText ??
            `Customer promised to pay by ${promiseDate}${timeProvided ? ` ${promiseTime}` : ""} (recorded by ${resolvedAdminName}).`,
          "no_response"
        ),
      ],
    }));

    if (!updated) {
      return NextResponse.json({ error: `Transaction ${id} not found.` }, { status: 404 });
    }

    await syncRecoveryCaseFor(updated);

    const existingPromises = await readPromisesToPay();
    const existingPromise = existingPromises.find((p) => p.transactionId === updated.id);
    await recordPromiseToPay(
      buildAdminRecordedPromise(updated, promiseDate, timeProvided, promiseAtIso, noteText, existingPromise)
    );

    await resolveEscalationForTransaction(updated.id, {
      action: "promise_to_pay_recorded",
      note: noteText,
      resolvedBy: resolvedAdminName,
      resolvedAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, transaction: updated });
  } finally {
    releaseLock(id);
  }
}
