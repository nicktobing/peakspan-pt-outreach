import { start } from "workflow/api";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { getLikeTarget, likeEnvironmentAllowsWrites } from "@/lib/config/likes";
import { getDb } from "@/lib/db/client";
import { LikeRepository } from "@/lib/db/likes";
import { instagramPost, likeRequestSchema } from "@/lib/likes/contracts";
import { canStartLike } from "@/lib/likes/runtime";
import { dispatchLike } from "@/lib/likes/service";
import { instagramLikeWorkflow } from "@/lib/workflows/instagram-like";
import { z } from "zod";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN);
  if (denied) return denied;
  if (!likeEnvironmentAllowsWrites()) return Response.json({ status: "disabled" });
  try {
    const text = await request.text();
    if (text.length > 8000) return Response.json({ error: "Request too large" }, { status: 413 });
    const parsed = likeRequestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return Response.json({ error: "Invalid like request" }, { status: 400 });
    const target = getLikeTarget();
    if (parsed.data.contactId !== target.contactId || instagramPost(parsed.data.postUrl).shortcode !== instagramPost(target.postUrl).shortcode) {
      return Response.json({ error: "Request is outside the configured pilot" }, { status: 403 });
    }
    if (!(await canStartLike(target))) return Response.json({ error: "Like is not authorized" }, { status: 403 });
    const result = await dispatchLike(new LikeRepository(getDb()), target, async (id) => (await start(instagramLikeWorkflow, [id, "execute"])).runId);
    return Response.json(result, { status: result.status === "accepted" ? 202 : result.status === "dispatch_unknown" ? 503 : 200 });
  } catch (error) {
    return Response.json({ error: error instanceof SyntaxError ? "Invalid JSON" : "Like request unavailable" }, { status: error instanceof SyntaxError ? 400 : 503 });
  }
}
export async function GET(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN);
  if (denied) return denied;
  const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get("id"));
  if (!id.success) return Response.json({ error: "Invalid action ID" }, { status: 400 });
  try { return Response.json(await new LikeRepository(getDb()).progress(id.data)); }
  catch { return Response.json({ error: "Like status unavailable" }, { status: 503 }); }
}

