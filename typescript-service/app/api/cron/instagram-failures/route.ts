import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { runFailureAlerts } from "@/lib/likes/failure-runtime";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().CRON_SECRET); if (denied) return denied;
  try {
    const result = await runFailureAlerts();
    return Response.json(result, { status: "uncertain" in result && result.uncertain ? 503 : 200 });
  } catch { return Response.json({ error: "Failure alert check unavailable" }, { status: 503 }); }
}

