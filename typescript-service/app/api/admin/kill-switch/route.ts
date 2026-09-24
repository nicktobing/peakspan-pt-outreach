import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { listActionSwitches, setActionSwitch } from "@/lib/db/settings";
import { outboundActionSchema } from "@/lib/domain/outbound";
import { z } from "zod";

const updateSchema = z.object({
  action: outboundActionSchema,
  disabled: z.boolean(),
  reason: z.string().trim().min(1).max(500),
  updatedBy: z.string().trim().min(1).max(200),
});

function authorize(request: Request) {
  return requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN);
}

export async function GET(request: Request) {
  const authFailure = authorize(request);
  if (authFailure) return authFailure;

  return Response.json({ switches: await listActionSwitches() });
}

export async function POST(request: Request) {
  const authFailure = authorize(request);
  if (authFailure) return authFailure;

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid kill-switch update" }, { status: 400 });
  }

  const setting = await setActionSwitch(parsed.data);
  return Response.json({ setting });
}
