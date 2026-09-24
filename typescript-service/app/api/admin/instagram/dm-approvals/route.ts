import { z } from "zod";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { engagementAccount } from "@/lib/config/engagement";
import { getDb } from "@/lib/db/client";
import { DmApprovalRepository, dmDraftItemSchema } from "@/lib/db/dm-approvals";

const createSchema = z.object({ operation: z.literal("create"), items: z.array(dmDraftItemSchema).min(1).max(10) }).strict();
const decideSchema = z.object({ operation: z.literal("decide"), id: z.uuid(), decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string().trim().min(1).max(200) }).strict();
const inputSchema = z.discriminatedUnion("operation", [createSchema, decideSchema]);
export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  if (process.env.IG_DM_DRAFTS_ENABLED !== "true") return Response.json({ status: "disabled" });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid DM approval request" }, { status: 400 });
  try {
    const repository = new DmApprovalRepository(getDb());
    if (parsed.data.operation === "create") return Response.json(await repository.create({ version: 1, ...engagementAccount(), items: parsed.data.items }), { status: 201 });
    return Response.json(await repository.decide(parsed.data.id, parsed.data.decision, parsed.data.decidedBy));
  } catch { return Response.json({ error: "DM approval request unavailable" }, { status: 503 }); }
}
export async function GET(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("id"));
  if (!id.success) return Response.json({ error: "Invalid approval ID" }, { status: 400 });
  try { return Response.json(await new DmApprovalRepository(getDb()).read(id.data)); }
  catch { return Response.json({ error: "DM approval unavailable" }, { status: 503 }); }
}

