import { z } from "zod";
import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { actionEligible, campaignContactSchema, followupDue } from "@/lib/domain/eligibility";

const inputSchema = z.object({ contact: campaignContactSchema.extend({ tags: z.array(z.string().max(200)).max(200) }),
  asOf: z.iso.datetime({ offset: true }).optional() }).strict();

export async function POST(request: Request) {
  let token: string;
  try { token = getCoreEnv().ADMIN_API_TOKEN; }
  catch { return Response.json({ error: "Service configuration unavailable" }, { status: 503 }); }
  const denied = requireBearerSecret(request, token);
  if (denied) return denied;
  let input: unknown;
  try {
    const body = await request.text();
    if (body.length > 32_000) return Response.json({ error: "Snapshot too large" }, { status: 413 });
    input = JSON.parse(body);
  } catch { return Response.json({ error: "Invalid snapshot" }, { status: 400 }); }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return Response.json({ error: "Invalid snapshot" }, { status: 400 });
  const now = parsed.data.asOf ? new Date(parsed.data.asOf) : new Date();
  const actions = ["follow", "comment_1", "comment_2", "comment_3", "dm"] as const;
  return Response.json({ simulation: true, inputSource: "supplied_snapshot", authorizesSending: false,
    evaluatedAt: now.toISOString(), eligibility: Object.fromEntries(actions.map((action) => [action, actionEligible(parsed.data.contact, action)])),
    followup: followupDue(parsed.data.contact, now),
  });
}

