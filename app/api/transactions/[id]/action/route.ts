import { NextRequest, NextResponse } from "next/server";
import {
  markPaymentRecovered,
  recordOfflinePayment,
  setCustomerOptOut,
  stopRecovery,
  type OfflinePaymentMethod,
} from "@/lib/manual-payment-actions";

const OFFLINE_METHODS: OfflinePaymentMethod[] = ["cash", "bank_transfer", "other"];

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

  const { action, adminName, note, method, amount } = (body ?? {}) as Record<string, unknown>;

  if (adminName !== undefined && typeof adminName !== "string") {
    return NextResponse.json({ error: '"adminName" must be a string if provided.' }, { status: 400 });
  }
  if (note !== undefined && typeof note !== "string") {
    return NextResponse.json({ error: '"note" must be a string if provided.' }, { status: 400 });
  }
  const resolvedAdminName = typeof adminName === "string" && adminName.trim() ? adminName : "Admin";
  const resolvedNote = typeof note === "string" && note.trim() ? note : undefined;

  if (action === "mark_recovered") {
    const result = await markPaymentRecovered({
      transactionId: id,
      adminName: resolvedAdminName,
      note: resolvedNote,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  }

  if (action === "stop_recovery") {
    const result = await stopRecovery({
      transactionId: id,
      adminName: resolvedAdminName,
      note: resolvedNote,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  }

  if (action === "record_offline_payment") {
    if (typeof method !== "string" || !OFFLINE_METHODS.includes(method as OfflinePaymentMethod)) {
      return NextResponse.json(
        { error: `"method" is required and must be one of: ${OFFLINE_METHODS.join(", ")}.` },
        { status: 400 }
      );
    }
    if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)) {
      return NextResponse.json({ error: '"amount" must be a positive number if provided.' }, { status: 400 });
    }
    const result = await recordOfflinePayment({
      transactionId: id,
      method: method as OfflinePaymentMethod,
      adminName: resolvedAdminName,
      note: resolvedNote,
      amount: typeof amount === "number" ? amount : undefined,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  }

  if (action === "opt_out_customer" || action === "opt_in_customer") {
    const result = await setCustomerOptOut({
      transactionId: id,
      optedOut: action === "opt_out_customer",
      adminName: resolvedAdminName,
      note: resolvedNote,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  }

  return NextResponse.json(
    {
      error:
        '"action" is required and must be one of: mark_recovered, stop_recovery, record_offline_payment, opt_out_customer, opt_in_customer.',
    },
    { status: 400 }
  );
}
