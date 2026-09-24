import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { actionAttempts, inboundEvents, inboxMessages, suppressionEntries, workflowRuns } from "./schema";

const textId = z.string().trim().min(1).max(250);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

// SQL uniqueness owns claims. A duplicate claim never authorizes another send.
// No method resets a claimed or unknown-outcome action to pending.
export class ExecutionRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}

  async claimAction(value: { contactId: string; action: string; idempotencyKey: string }) {
    const input = z.object({ contactId: textId, action: textId, idempotencyKey: textId }).parse(value);
    const [created] = await this.db.insert(actionAttempts).values({ ...input, status: "running" })
      .onConflictDoNothing({ target: actionAttempts.idempotencyKey }).returning();
    if (created) return { acquired: true, attempt: created };
    const [existing] = await this.db.select().from(actionAttempts).where(eq(actionAttempts.idempotencyKey, input.idempotencyKey));
    if (!existing || existing.contactId !== input.contactId || existing.action !== input.action) throw new Error("Action claim identity mismatch");
    return { acquired: false, attempt: existing };
  }

  async recordProviderRun(attemptId: string, providerRunId: string) {
    z.string().uuid().parse(attemptId); textId.parse(providerRunId);
    // A recorded reference cannot be replaced by a later replay.
    const [row] = await this.db.update(actionAttempts).set({ providerRunId, updatedAt: new Date() })
      .where(and(eq(actionAttempts.id, attemptId), eq(actionAttempts.status, "running"),
        // Null-safe conditional performed by SQL, not an in-memory read.
        sqlReferenceUnset())).returning();
    return row ?? null;
  }

  async finishAction(attemptId: string, outcome: "succeeded" | "failed" | "unknown", costUsd?: number) {
    z.string().uuid().parse(attemptId);
    z.enum(["succeeded", "failed", "unknown"]).parse(outcome);
    z.number().nonnegative().max(999999).optional().parse(costUsd);
    const [row] = await this.db.update(actionAttempts).set({
      status: outcome === "unknown" ? "paused" : outcome,
      errorCode: outcome === "unknown" ? "unknown_outcome" : null,
      costUsd: costUsd === undefined ? undefined : costUsd.toFixed(6), updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, attemptId), eq(actionAttempts.status, "running"))).returning();
    return row ?? null;
  }

  async claimSchedule(value: { workflow: string; scheduledWindow: string; workflowRunId: string }) {
    const input = z.object({ workflow: textId, scheduledWindow: textId, workflowRunId: textId }).parse(value);
    const [row] = await this.db.insert(workflowRuns).values(input).onConflictDoNothing().returning();
    return row ?? null;
  }

  async receiveEvent(value: { source: string; externalId: string; payloadHash: string; payload: unknown }) {
    const input = z.object({ source: textId, externalId: textId, payloadHash: digest, payload: z.json() }).parse(value);
    const [created] = await this.db.insert(inboundEvents).values(input)
      .onConflictDoNothing({ target: [inboundEvents.source, inboundEvents.externalId] }).returning();
    if (created) return { acquired: true, event: created };
    const [existing] = await this.db.select().from(inboundEvents)
      .where(and(eq(inboundEvents.source, input.source), eq(inboundEvents.externalId, input.externalId)));
    if (!existing || existing.payloadHash !== input.payloadHash) throw new Error("Inbound event identity mismatch");
    return { acquired: false, event: existing };
  }

  async suppress(value: { contactId: string; reason: string; source: string }) {
    const input = z.object({ contactId: textId, reason: textId, source: textId }).parse(value);
    // Never downgrade an existing permanent opt-out or overwrite its evidence.
    const [row] = await this.db.insert(suppressionEntries).values(input)
      .onConflictDoUpdate({ target: suppressionEntries.contactId, set: { active: true, updatedAt: new Date() } }).returning();
    return row;
  }

  async isSuppressed(contactId: string) {
    const normalizedContactId = textId.parse(contactId);
    const [row] = await this.db.select({ active: suppressionEntries.active }).from(suppressionEntries)
      .where(eq(suppressionEntries.contactId, normalizedContactId));
    return row?.active ?? false;
  }

  async receiveInboxMessage(value: { providerMessageId: string; contactId: string; receivedAt: Date; preview: string }) {
    const input = z.object({ providerMessageId: textId, contactId: textId, receivedAt: z.date(), preview: z.string().max(500) }).parse(value);
    const [row] = await this.db.insert(inboxMessages).values(input)
      .onConflictDoNothing({ target: inboxMessages.providerMessageId }).returning();
    return row ?? null;
  }
}

import { isNull } from "drizzle-orm";
function sqlReferenceUnset() { return isNull(actionAttempts.providerRunId); }


