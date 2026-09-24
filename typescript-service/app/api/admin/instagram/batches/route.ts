import { z } from "zod";
import { start } from "workflow/api";
import { getCoreEnv } from "@/lib/config/env";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { getDb } from "@/lib/db/client";
import { LikeBatchRepository } from "@/lib/db/like-batches";
import { batchCandidates, batchEnabled, batchProfileFields, prepareBatch } from "@/lib/likes/batch-runtime";
import { instagramBatchWorkflow } from "@/lib/workflows/instagram-batch";

export const dynamic = "force-dynamic";
function authorize(request: Request) { return requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); }
export async function GET(request: Request) {
  const denied = authorize(request); if (denied) return denied;
  try {
    const query = new URL(request.url).searchParams;
    if (query.get("view") === "fields") return Response.json({ fields: await batchProfileFields() });
    if (query.get("view") === "candidates") return Response.json(await batchCandidates());
    const repository = new LikeBatchRepository(getDb());
    if (query.has("id")) {
      const id = z.uuid().parse(query.get("id")); const row = await repository.read(id);
      return Response.json({ id, status: row.status, state: row.state, updatedAt: row.updatedAt, workflowRunId: row.workflowRunId });
    }
    return Response.json({ sessions: await repository.list() });
  } catch { return Response.json({ error: "Session inspection unavailable" }, { status: 503 }); }
}
export async function POST(request: Request) {
  const denied = authorize(request); if (denied) return denied;
  try {
    const raw = await request.text(); if (raw.length > 2000) return Response.json({ error: "Request too large" }, { status: 413 });
    const input = z.object({ requestId: z.uuid(), mode: z.enum(["preview", "execute"]).default("preview") }).strict().parse(JSON.parse(raw));
    const claim = await prepareBatch(input.requestId, input.mode);
    if (!claim.acquired) return Response.json({ status: "duplicate", sessionId: claim.id });
    try { const run = await start(instagramBatchWorkflow, [claim.id]); await new LikeBatchRepository(getDb()).linkWorkflow(claim.id, run.runId); }
    catch { await new LikeBatchRepository(getDb()).pause(claim.id, "dispatch_unknown"); return Response.json({ status: "needs_attention", sessionId: claim.id }, { status: 503 }); }
    return Response.json({ status: "accepted", sessionId: claim.id }, { status: 202 });
  } catch { return Response.json({ error: "Session unavailable: check configuration, account lock and limits" }, { status: 503 }); }
}
export async function PATCH(request: Request) {
  const denied = authorize(request); if (denied) return denied;
  try {
    const raw = await request.text(); if (raw.length > 2000) return Response.json({ error: "Request too large" }, { status: 413 });
    const input = z.object({ sessionId: z.uuid(), action: z.enum(["cancel", "resume"]) }).strict().parse(JSON.parse(raw));
    const repository = new LikeBatchRepository(getDb());
    if (input.action === "cancel") return Response.json({ status: await repository.cancel(input.sessionId) });
    const row = await repository.read(input.sessionId);
    if (!batchEnabled(row.state.mode)) return Response.json({ error: "Session mode is disabled" }, { status: 403 });
    if (!await repository.resume(input.sessionId)) return Response.json({ status: "unchanged" });
    try { const run = await start(instagramBatchWorkflow, [input.sessionId]); await repository.linkWorkflow(input.sessionId, run.runId); }
    catch { await repository.pause(input.sessionId, "dispatch_unknown"); return Response.json({ status: "needs_attention" }, { status: 503 }); }
    return Response.json({ status: "accepted", sessionId: input.sessionId }, { status: 202 });
  } catch { return Response.json({ error: "Session recovery unavailable; inspect existing provider references before retrying" }, { status: 409 }); }
}

