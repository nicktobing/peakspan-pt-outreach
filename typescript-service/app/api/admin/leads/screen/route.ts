import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { GhlClient } from "@/lib/clients/ghl";
import { leadScreenInput, screenDirectory } from "@/lib/leads/screen";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  const raw = await request.text();
  if (raw.length > 3_500_000) return Response.json({ error: "Lead list too large" }, { status: 413 });
  let input;
  try { input = leadScreenInput.parse(JSON.parse(raw)); }
  catch { return Response.json({ error: "Invalid lead list" }, { status: 400 }); }
  try {
    const client = new GhlClient(process.env.GHL_API_TOKEN ?? "", process.env.GHL_LOCATION_ID ?? "");
    const fields = await client.listCustomFields();
    const profileFields = new Set(fields.filter((field) => /(?:instagram|ig_profile|profile_url)/i.test(field.fieldKey)).map((field) => field.id));
    if (process.env.GHL_IG_PROFILE_FIELD_ID) profileFields.add(process.env.GHL_IG_PROFILE_FIELD_ID);
    // A failed or partial GHL scan must never turn every CSV row into a new lead.
    const contacts = await client.listContacts();
    return Response.json(screenDirectory(input.leads, contacts, profileFields), { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "GHL duplicate check incomplete; no leads cleared for outreach" }, { status: 503 }); }
}

