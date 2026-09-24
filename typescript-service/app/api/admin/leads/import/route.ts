import { requireBearerSecret } from "@/lib/auth/secrets";
import { getCoreEnv } from "@/lib/config/env";
import { directoryRecords, importDirectoryLead, inspectDirectoryImport, reconcileDirectoryImport, retryRejectedDirectoryImport } from "@/lib/leads/runtime";
import { z } from "zod";
import { AdmissionRepository } from "@/lib/leads/admissions";
import { getDb } from "@/lib/db/client";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try { const id = new URL(request.url).searchParams.get("id");
    return Response.json(id ? new URL(request.url).searchParams.has("inspect") ? await inspectDirectoryImport(id) : await new AdmissionRepository(getDb()).read(id) : { records: await directoryRecords() }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Import inspection unavailable" }, { status: 503 }); }
}
export async function PATCH(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try {
    const raw = await request.text(); if (raw.length > 1000) return Response.json({ error: "Input too large" }, { status: 413 });
    const { id, action } = z.object({ id: z.uuid(), action: z.enum(["reconcile", "retry_rejected"]) }).strict().parse(JSON.parse(raw));
    const row = action === "reconcile" ? await reconcileDirectoryImport(id) : await retryRejectedDirectoryImport(id);
    return Response.json({ id: row.id, status: row.status, phase: row.data.phase, contactId: row.data.contactId, failureCode: row.data.failureCode }, { status: row.status === "paused" ? 503 : 200 });
  } catch { return Response.json({ error: "Known-contact reconciliation unavailable" }, { status: 409 }); }
}
export async function POST(request: Request) {
  const denied = requireBearerSecret(request, getCoreEnv().ADMIN_API_TOKEN); if (denied) return denied;
  try {
    const raw = await request.text(); if (raw.length > 200000) return Response.json({ error: "Input too large" }, { status: 413 });
    const row = await importDirectoryLead(JSON.parse(raw));
    return Response.json({ id: row.id, status: row.status, phase: row.data.phase, contactId: row.data.contactId }, { status: row.status === "paused" ? 503 : 200 });
  } catch { return Response.json({ error: "Import unavailable; check enable flag, qualification and previous import state" }, { status: 409 }); }
}

