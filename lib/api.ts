import { NextResponse } from "next/server";

import type { ServiceResult } from "./payments";

export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export function invalidJson(): NextResponse {
  return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
}

export function internalError(error: unknown): NextResponse {
  console.error("[api] unhandled error", error);
  return errorResponse(500, "INTERNAL_ERROR", "Something went wrong while processing the request.");
}

export function respond(result: ServiceResult): NextResponse {
  const headers = result.replayed ? { "Idempotent-Replayed": "true" } : undefined;
  return NextResponse.json(result.body, { status: result.status, headers });
}
