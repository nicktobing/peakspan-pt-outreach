import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { getLikeCookies, getLikeTarget, likeEnvironmentAllowsWrites } from "@/lib/config/likes";
import { GhlClient } from "@/lib/clients/ghl";
import { getDb } from "@/lib/db/client";
import { getActionSwitch } from "@/lib/db/settings";
import { ExecutionRepository } from "@/lib/db/repositories";
import { isSuppressed } from "@/lib/domain/eligibility";

export const dynamic = "force-dynamic";

// Read-only checks for the configured pilot. Never starts an actor or writes to GHL.
export async function GET(request: Request) {
  let token: string;
  try { token = getCoreEnv().ADMIN_API_TOKEN; }
  catch { return Response.json({ error: "Service configuration unavailable" }, { status: 503 }); }
  const denied = requireBearerSecret(request, token);
  if (denied) return denied;
  try {
    const target = getLikeTarget();
    let cookiesValid = false;
    try { getLikeCookies(target.accountId); cookiesValid = true; } catch { /* sanitized below */ }
    const setting = await getActionSwitch("like");
    let contactVerified = false;
    let qualified = false;
    let suppressed: boolean | null = null;
    try {
      const contact = await new GhlClient(process.env.GHL_API_TOKEN ?? "", process.env.GHL_LOCATION_ID ?? "").getContact(target.contactId);
      contactVerified = contact.id === target.contactId;
      qualified = contact.tags.some((tag) => tag.trim().toLowerCase() === "qualified");
      suppressed = isSuppressed(contact.tags, await new ExecutionRepository(getDb()).isSuppressed(target.contactId));
    } catch { /* no raw provider data or errors returned */ }
    return Response.json({
      environmentAllowsWrites: likeEnvironmentAllowsWrites(),
      databaseAllowsWrites: setting?.disabled === false,
      cookiesValid, accountUsername: target.accountUsername, targetUsername: target.targetUsername,
      contactVerified, qualified, suppressed,
      apifyTokenPresent: Boolean(process.env.APIFY_API_TOKEN),
      instagramSessionVerified: false,
    });
  } catch { return Response.json({ error: "Pilot preflight unavailable" }, { status: 503 }); }
}

