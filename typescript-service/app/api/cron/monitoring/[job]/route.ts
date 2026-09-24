import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { getMonitoringConfig } from "@/lib/config/monitoring";
import { getDb } from "@/lib/db/client";
import { MonitoringRepository } from "@/lib/db/monitoring";
import { monitoringJobSchema } from "@/lib/domain/schedules";
import { dispatchMonitoringCron } from "@/lib/monitoring/cron";
import { monitoringWorkflow } from "@/lib/workflows/monitoring";
import { start } from "workflow/api";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ job: string }> }) {
  try {
    const denied = requireBearerSecret(request, getCoreEnv().CRON_SECRET);
    if (denied) return denied;
    const job = monitoringJobSchema.safeParse((await context.params).job);
    if (!job.success) return Response.json({ error: "Unknown monitoring job" }, { status: 404 });
    const config = getMonitoringConfig();
    if (!config.enabled) return Response.json({ status: "disabled" });
    const result = await dispatchMonitoringCron(new MonitoringRepository(getDb()), job.data, new Date(),
      async (businessRunId) => (await start(monitoringWorkflow, [businessRunId])).runId, config);
    return Response.json(result, { status: result.status === "accepted" ? 202 : result.status === "dispatch_unknown" ? 503 : 200 });
  } catch { return Response.json({ error: "Monitoring unavailable" }, { status: 503 }); }
}

