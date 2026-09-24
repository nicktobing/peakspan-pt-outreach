import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { createApprovedPipelineOpportunities, pipelineCreationApprovalSchema } from "@/lib/pipeline/runtime";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  const parsed = pipelineCreationApprovalSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid pipeline creation approval" }, { status: 400 });
  try {
    const result = await createApprovedPipelineOpportunities(parsed.data);
    return Response.json(result, { status: result.status === "complete" ? 200 :
      result.status === "blocked" || result.status === "already_claimed" ? 409 : 503 });
  } catch { return Response.json({ error: "Pipeline creation unavailable; inspect the preview before retrying" }, { status: 503 }); }
}
