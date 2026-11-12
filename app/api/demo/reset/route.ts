import { internalError, respond } from "@/lib/api";
import { resetDemoData } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return respond(await resetDemoData());
  } catch (error) {
    return internalError(error);
  }
}
