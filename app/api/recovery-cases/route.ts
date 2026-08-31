import { NextResponse } from "next/server";
import { readRecoveryCases } from "@/lib/recovery-case-store";

export async function GET() {
  try {
    const cases = await readRecoveryCases();
    return NextResponse.json({ cases });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to read recovery-cases.json: ${error.message}`
            : "Failed to read recovery-cases.json.",
      },
      { status: 500 }
    );
  }
}
