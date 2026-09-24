import { start } from "workflow/api";
import { z } from "zod";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { engagementAccount, engagementEnvironmentAllowsWrites } from "@/lib/config/engagement";
import { getDb } from "@/lib/db/client";
import { EngagementRepository } from "@/lib/db/engagement";
import { engagementRequestSchema, engagementTargetSchema } from "@/lib/engagement/contracts";
import { engagementAllowed } from "@/lib/engagement/runtime";
import { dispatchEngagement } from "@/lib/engagement/service";
import { instagramEngagementWorkflow } from "@/lib/workflows/instagram-engagement";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try {
    const text = await request.text(); if (text.length > 12_000) return Response.json({ error: "Request too large" }, { status: 413 });
    const parsed = engagementRequestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return Response.json({ error: "Invalid engagement request" }, { status: 400 });
    if (!engagementEnvironmentAllowsWrites(parsed.data.action)) return Response.json({ status: "disabled" });
    const { username, ...requestData } = parsed.data;
    const target = engagementTargetSchema.parse({ ...engagementAccount(), ...requestData, targetUsername: username });
    if (!(await engagementAllowed(target))) return Response.json({ error: "Engagement is not authorized" }, { status: 403 });
    const result = await dispatchEngagement(new EngagementRepository(getDb()), target,
      async (id) => (await start(instagramEngagementWorkflow, [id, "execute"])).runId);
    return Response.json(result, { status: result.status === "accepted" ? 202 : result.status === "dispatch_unknown" ? 503 : 200 });
  } catch (error) { return Response.json({ error: error instanceof SyntaxError ? "Invalid JSON" : "Engagement request unavailable" },
    { status: error instanceof SyntaxError ? 400 : 503 }); }
}
export async function GET(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get("id"));
  if (!id.success) return Response.json({ error: "Invalid action ID" }, { status: 400 });
  try { return Response.json(await new EngagementRepository(getDb()).progress(id.data)); }
  catch { return Response.json({ error: "Engagement status unavailable" }, { status: 503 }); }
}
export async function PATCH(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try {
    const text = await request.text(); if (text.length > 2_000) return Response.json({ error: "Request too large" }, { status: 413 });
    const parsed = z.object({ action: z.literal("cancel_paused_unknown"), id: z.string().uuid(),
      providerRunId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict().safeParse(JSON.parse(text));
    if (!parsed.success) return Response.json({ error: "Invalid engagement resolution" }, { status: 400 });
    return Response.json(await new EngagementRepository(getDb()).cancelPausedUnknown(parsed.data.id, parsed.data.providerRunId));
  } catch (error) { return Response.json({ error: error instanceof SyntaxError ? "Invalid JSON" : "Engagement resolution unavailable" },
    { status: error instanceof SyntaxError ? 400 : 409 }); }
}

