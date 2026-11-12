import { NextResponse } from "next/server";

import { errorResponse, invalidJson, internalError, respond } from "@/lib/api";
import { createPayment, listPayments } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = new URL(request.url).searchParams.get("limit");
  try {
    const result = await listPayments(limit);
    if (!result.ok) return errorResponse(400, "VALIDATION_ERROR", result.message);
    return NextResponse.json({ payments: result.payments });
  } catch (error) {
    return internalError(error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  try {
    const idempotencyKey = request.headers.get("Idempotency-Key");
    return respond(await createPayment(body, idempotencyKey));
  } catch (error) {
    return internalError(error);
  }
}
