import { NextResponse } from "next/server";
import { getBatchProgress } from "@/lib/batch-progress";

export async function GET() {
  return NextResponse.json(getBatchProgress());
}
