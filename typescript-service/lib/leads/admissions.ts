import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { actionAttempts, settings } from "../db/schema";
import { directoryLeadSchema } from "./screen";
import { instagramUsername } from "../likes/contracts";
import { idempotencyKey, payloadHash } from "../domain/idempotency";

export const DIRECTORY_ACTION = "directory_import";
export const DIRECTORY_TAG = "peakspan-directory-qualified";
export const admissionInput = z.object({ lead: directoryLeadSchema, variants: z.array(directoryLeadSchema).max(100).default([]), qualification: z.object({
  australianPtBusiness: z.literal(true), officialInstagramLinked: z.literal(true),
  evidenceUrls: z.array(z.url()).min(1).max(5), rationale: z.string().trim().min(20).max(2000),
  checkedAt: z.iso.datetime(),
}).strict() }).strict();
const recordSchema = admissionInput.extend({ username: instagramUsername, locationId: z.string().min(1),
  phase: z.enum(["checking", "creating", "verifying", "noting", "tagging", "complete", "duplicate", "paused"]),
  contactId: z.string().optional(), reason: z.string().optional(), createdNew: z.boolean().optional(),
  pausedFrom: z.string().max(50).optional(), failureCode: z.string().max(100).optional(), retryCount: z.number().int().min(0).max(1).optional() });
export type Admission = z.infer<typeof recordSchema>;
export class AdmissionRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}
  async claim(locationId: string, input: z.infer<typeof admissionInput>) {
    const clean = admissionInput.parse(input); const username = instagramUsername.parse(clean.lead.instagram_url);
    const key = idempotencyKey(DIRECTORY_ACTION, locationId, username);
    return this.db.transaction(async (tx) => {
      const lock = `directory_import_lock:${locationId}`;
      await tx.insert(settings).values({ key: lock, value: {}, updatedBy: DIRECTORY_ACTION }).onConflictDoNothing();
      await tx.select().from(settings).where(eq(settings.key, lock)).for("update");
      const [prior] = await tx.select().from(actionAttempts).where(eq(actionAttempts.idempotencyKey, key));
      if (prior) {
        const data = recordSchema.parse(prior.result);
        if (payloadHash(JSON.stringify([data.lead, data.variants])) !== payloadHash(JSON.stringify([clean.lead, clean.variants]))) throw new Error("Import identity changed");
        return { acquired: false, id: prior.id };
      }
      // A persistent claim, not a request-scoped mutex. Worker loss/unknown creation blocks later imports.
      const active = await tx.select().from(actionAttempts).where(and(eq(actionAttempts.action, DIRECTORY_ACTION), inArray(actionAttempts.status, ["running", "paused"])));
      if (active.some((row) => recordSchema.parse(row.result).locationId === locationId)) throw new Error("Prior import needs attention");
      const result = recordSchema.parse({ ...clean, username, locationId, phase: "checking" });
      const [row] = await tx.insert(actionAttempts).values({ action: DIRECTORY_ACTION, contactId: `directory:${username}`,
        idempotencyKey: key, status: "running", result }).returning();
      return { acquired: true, id: row.id };
    });
  }
  async read(id: string) {
    const [row] = await this.db.select().from(actionAttempts).where(and(eq(actionAttempts.id, z.uuid().parse(id)), eq(actionAttempts.action, DIRECTORY_ACTION)));
    if (!row) throw new Error("Unknown import"); return { ...row, data: recordSchema.parse(row.result) };
  }
  async set(id: string, update: Partial<Admission>, status: "running" | "paused" | "succeeded" | "cancelled" = "running") {
    const row = await this.read(id);
    await this.db.update(actionAttempts).set({ result: recordSchema.parse({ ...row.data, ...update }), status,
      ...(update.contactId ? { contactId: update.contactId } : {}), updatedAt: new Date() }).where(eq(actionAttempts.id, id));
  }
  async completed(locationId: string) {
    const rows = await this.db.select().from(actionAttempts).where(and(eq(actionAttempts.action, DIRECTORY_ACTION), eq(actionAttempts.status, "succeeded")));
    return rows.map((row) => ({ id: row.id, ...recordSchema.parse(row.result) })).filter((row) => row.locationId === locationId && row.phase === "complete" && row.contactId);
  }
  async claimReconciliation(id: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(actionAttempts).where(and(eq(actionAttempts.id, z.uuid().parse(id)), eq(actionAttempts.action, DIRECTORY_ACTION))).for("update");
      if (!row || row.status !== "paused") return false;
      const data = recordSchema.parse(row.result);
      if (!data.contactId || Date.now() - row.updatedAt.getTime() < 60000) throw new Error("Saved contact and settled provider state required");
      await tx.update(actionAttempts).set({ status: "running", result: { ...data, phase: "verifying" }, updatedAt: new Date() }).where(eq(actionAttempts.id, id));
      return true;
    });
  }
  async claimRejectedRetry(id: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(actionAttempts).where(and(eq(actionAttempts.id, z.uuid().parse(id)), eq(actionAttempts.action, DIRECTORY_ACTION))).for("update");
      if (!row || row.status !== "paused") return false;
      const data = recordSchema.parse(row.result);
      if (data.contactId || data.pausedFrom !== "creating" || data.failureCode !== "ghl_permanent_400" || data.retryCount ||
        Date.now() - row.updatedAt.getTime() < 60000) throw new Error("Settled rejected create required");
      await tx.update(actionAttempts).set({ status: "running", result: recordSchema.parse({ ...data, phase: "creating", retryCount: 1, reason: "retrying_rejected_create" }),
        updatedAt: new Date() }).where(eq(actionAttempts.id, id));
      return true;
    });
  }
}

