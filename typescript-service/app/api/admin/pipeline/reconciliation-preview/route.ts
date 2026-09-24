import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { previewPipelineReconciliation } from "@/lib/pipeline/runtime";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try { return Response.json(await previewPipelineReconciliation()); }
  catch { return Response.json({ error: "Pipeline reconciliation preview unavailable" }, { status: 503 }); }
}
