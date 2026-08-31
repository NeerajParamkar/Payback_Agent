import { NextRequest, NextResponse } from "next/server";
import { performEscalationAction, type EscalationAdminAction } from "@/lib/escalation-actions";

const VALID_ACTIONS: EscalationAdminAction[] = [
  "resolve",
  "stop_recovery",
  "mark_recovered",
  "record_offline_payment",
  "send_payment_link",
  "take_ownership",
];

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

  const { action, adminName, note } = (body ?? {}) as Record<string, unknown>;

  if (typeof action !== "string" || !VALID_ACTIONS.includes(action as EscalationAdminAction)) {
    return NextResponse.json(
      { error: `"action" is required and must be one of: ${VALID_ACTIONS.join(", ")}.` },
      { status: 400 }
    );
  }
  if (adminName !== undefined && typeof adminName !== "string") {
    return NextResponse.json({ error: '"adminName" must be a string if provided.' }, { status: 400 });
  }
  if (note !== undefined && typeof note !== "string") {
    return NextResponse.json({ error: '"note" must be a string if provided.' }, { status: 400 });
  }

  try {
    const result = await performEscalationAction({
      entryId: id,
      action: action as EscalationAdminAction,
      adminName: typeof adminName === "string" && adminName.trim() ? adminName : "Admin",
      note: typeof note === "string" && note.trim() ? note : undefined,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to perform escalation action: ${error.message}`
            : "Failed to perform escalation action.",
      },
      { status: 500 }
    );
  }
}
