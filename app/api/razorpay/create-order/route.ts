import { NextRequest, NextResponse } from "next/server";
import {
  createRecoveryOrder,
  type CreateRecoveryOrderInput,
} from "@/lib/razorpay";

interface RazorpayApiError {
  statusCode?: string | number;
  error?: {
    code?: string;
    description?: string;
  };
}

function isRazorpayApiError(error: unknown): error is RazorpayApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof (error as { error?: unknown }).error === "object"
  );
}

type ValidationResult =
  | { ok: true; value: CreateRecoveryOrderInput }
  | { ok: false; error: string };

function validateInput(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { transactionId, amount, reason } = body as Record<string, unknown>;

  if (typeof transactionId !== "string" || transactionId.length === 0) {
    return {
      ok: false,
      error: '"transactionId" is required and must be a string.',
    };
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      error: '"amount" is required and must be a positive number (in INR).',
    };
  }
  if (typeof reason !== "string" || reason.length === 0) {
    return { ok: false, error: '"reason" is required and must be a string.' };
  }

  return { ok: true, value: { transactionId, amount, reason } };
}

function errorResponse(error: unknown): NextResponse {
  if (isRazorpayApiError(error)) {
    const statusCode = Number(error.statusCode);
    return NextResponse.json(
      {
        error: error.error?.description ?? "Razorpay API error.",
        code: error.error?.code,
      },
      { status: Number.isFinite(statusCode) ? statusCode : 502 }
    );
  }
  if (error instanceof Error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(
    { error: "Unknown error creating Razorpay order." },
    { status: 500 }
  );
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const validation = validateInput(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const order = await createRecoveryOrder(validation.value);
    return NextResponse.json(order);
  } catch (error) {
    return errorResponse(error);
  }
}
