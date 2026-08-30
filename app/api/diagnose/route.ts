import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";
import { diagnoseTransaction, type DiagnoseInput } from "@/lib/diagnose";
import { TRANSACTION_TYPES } from "@/lib/types";

type ValidationResult =
  | { ok: true; value: DiagnoseInput }
  | { ok: false; error: string };

function validateInput(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { id, type, amount, customerName } = body as Record<string, unknown>;

  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: '"id" is required and must be a string.' };
  }
  if (typeof type !== "string" || !TRANSACTION_TYPES.includes(type as (typeof TRANSACTION_TYPES)[number])) {
    return {
      ok: false,
      error: `"type" is required and must be one of: ${TRANSACTION_TYPES.join(", ")}.`,
    };
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      error: '"amount" is required and must be a positive number.',
    };
  }
  if (typeof customerName !== "string" || customerName.length === 0) {
    return {
      ok: false,
      error: '"customerName" is required and must be a string.',
    };
  }

  return {
    ok: true,
    value: {
      id,
      type: type as DiagnoseInput["type"],
      amount,
      customerName,
    },
  };
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof Groq.AuthenticationError) {
    return NextResponse.json(
      { error: "Groq API authentication failed. Check GROQ_API_KEY." },
      { status: 500 }
    );
  }
  if (error instanceof Groq.RateLimitError) {
    return NextResponse.json(
      { error: "Groq API rate limit exceeded. Try again shortly." },
      { status: 429 }
    );
  }
  if (error instanceof Groq.APIError) {
    return NextResponse.json(
      { error: `Groq API error: ${error.message}` },
      { status: 502 }
    );
  }
  if (error instanceof Error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(
    { error: "Unknown error during diagnosis." },
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
    const diagnosis = await diagnoseTransaction(validation.value);
    return NextResponse.json(diagnosis);
  } catch (error) {
    return errorResponse(error);
  }
}
