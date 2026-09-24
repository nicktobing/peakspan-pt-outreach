import { z } from "zod";
import { getCoreEnv } from "@/lib/config/env";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { failurePreflight, runFailureAlerts } from "@/lib/likes/failure-runtime";
import { FailureAlertRepository } from "@/lib/likes/failure-alerts";
import { getDb } from "@/lib/db/client";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try { return Response.json({ configuration: await failurePreflight(), alerts: await new FailureAlertRepository(getDb()).recent() }); }
  catch { return Response.json({ error: "Slack preflight unavailable" }, { status: 503 }); }
}
export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try {
    const raw = await request.text(); if (raw.length > 500) return Response.json({ error: "Request too large" }, { status: 413 });
    const input = z.object({ requestId: z.uuid(), test: z.literal(true) }).strict().parse(JSON.parse(raw));
    const result = await runFailureAlerts(input.requestId);
    return Response.json(result, { status: "disabled" in result ? 409 : "test" in result && result.test?.status === "sent" ? 200 : 503 });
  } catch { return Response.json({ error: "Alert test incomplete; inspect status before retrying with the same request ID" }, { status: 503 }); }
}

