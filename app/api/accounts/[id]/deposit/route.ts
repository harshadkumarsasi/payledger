import { invalidJson, internalError, respond } from "@/lib/api";
import { depositToAccount } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  try {
    return respond(await depositToAccount(id, body));
  } catch (error) {
    return internalError(error);
  }
}
