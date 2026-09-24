import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { noOpWorkflow } from "@/lib/workflows/no-op";
import { start } from "workflow/api";

export async function GET(request: Request) {
  const authFailure = requireBearerSecret(request, getCoreEnv().CRON_SECRET);
  if (authFailure) return authFailure;

  const run = await start(noOpWorkflow, [crypto.randomUUID()]);
  return Response.json({ accepted: true, runId: run.runId }, { status: 202 });
}
