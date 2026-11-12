import { NextResponse } from "next/server";

import { invalidJson, internalError, respond } from "@/lib/api";
import { createAccount, listAccounts } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ accounts: await listAccounts() });
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
    return respond(await createAccount(body));
  } catch (error) {
    return internalError(error);
  }
}
