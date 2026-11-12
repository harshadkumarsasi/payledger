import { NextResponse } from "next/server";

import { errorResponse, internalError } from "@/lib/api";
import { listLedger } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = new URL(request.url).searchParams.get("limit");
  try {
    const result = await listLedger(limit);
    if (!result.ok) return errorResponse(400, "VALIDATION_ERROR", result.message);
    return NextResponse.json({ entries: result.entries });
  } catch (error) {
    return internalError(error);
  }
}
