import { start } from "workflow/api";
import { z } from "zod";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { LikeRepository } from "@/lib/db/likes";
import { getDb } from "@/lib/db/client";
import { instagramLikeWorkflow } from "@/lib/workflows/instagram-like";

export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN);
  if (denied) return denied;
  if (process.env.IG_LIKE_ENABLED !== "true") return Response.json({ status: "disabled" });
  try {
    const text = await request.text();
    if (text.length > 8000) return Response.json({ error: "Request too large" }, { status: 413 });
    const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(JSON.parse(text));
    if (!parsed.success) return Response.json({ error: "Invalid reconciliation request" }, { status: 400 });
    const row = await new LikeRepository(getDb()).read(parsed.data.id);
    if (!row.providerRunId || !["polling", "provider_succeeded"].includes(row.data.phase)) {
      return Response.json({ error: "No provider result available for reconciliation" }, { status: 409 });
    }
    const run = await start(instagramLikeWorkflow, [row.id, "reconcile"]);
    return Response.json({ status: "accepted", workflowRunId: run.runId, id: row.id }, { status: 202 });
  } catch { return Response.json({ error: "Reconciliation dispatch uncertain; inspect the action before retrying" }, { status: 503 }); }
}

