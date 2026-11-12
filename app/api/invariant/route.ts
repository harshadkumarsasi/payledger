import { NextResponse } from "next/server";

import { internalError } from "@/lib/api";
import { getInvariant } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getInvariant());
  } catch (error) {
    return internalError(error);
  }
}
