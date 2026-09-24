import { start } from "workflow/api";
import { z } from "zod";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { EngagementRepository } from "@/lib/db/engagement";
import { instagramEngagementWorkflow } from "@/lib/workflows/instagram-engagement";

export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try {
    const parsed = z.object({ id: z.uuid() }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid reconciliation request" }, { status: 400 });
    const row = await new EngagementRepository(getDb()).read(parsed.data.id);
    if (!row.providerRunId || !["polling", "provider_succeeded"].includes(row.data.phase)) return Response.json({ error: "No provider result available" }, { status: 409 });
    const run = await start(instagramEngagementWorkflow, [row.id, "reconcile"]);
    return Response.json({ status: "accepted", workflowRunId: run.runId, id: row.id }, { status: 202 });
  } catch { return Response.json({ error: "Reconciliation dispatch uncertain; inspect the action before retrying" }, { status: 503 }); }
}

