import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { actionAttempts, messageAudit, settings, workflowRuns } from "./schema";
import { lockInstagramAccount, rollingInstagramActions, unresolvedInstagramAction } from "./instagram-budget";
import { batchConfig } from "../likes/batch-contracts";
import { idempotencyKey } from "../domain/idempotency";
import { engagementRecordSchema, engagementTargetSchema, sameEngagementTarget, switchFor,
  type EngagementAction, type EngagementRecord, type EngagementTarget } from "../engagement/contracts";

export class EngagementRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}

  async claim(value: EngagementTarget) {
    const target = engagementTargetSchema.parse(value);
    const key = idempotencyKey("instagram-engagement", target.accountId, target.contactId, target.action);
    return this.db.transaction(async (tx) => {
      await lockInstagramAccount(tx, target.accountId);
      const [existing] = await tx.select().from(actionAttempts).where(eq(actionAttempts.idempotencyKey, key));
      const [activeLikeBatch] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
        eq(workflowRuns.workflow, "instagram_like_batch"), inArray(workflowRuns.status, ["pending", "running", "paused"]),
        sql`${workflowRuns.result}->>'accountId' = ${target.accountId}`,
      )).limit(1);
      if (!existing && activeLikeBatch) throw new Error("An account like session is active");
      if (!existing && await unresolvedInstagramAction(tx, target.accountId)) throw new Error("Account has an unresolved action");
      if (!existing && await rollingInstagramActions(tx, target.accountId) >= batchConfig().IG_ROLLING_DAY_ACTION_LIMIT) {
        throw new Error("Rolling account action limit reached");
      }
      const [created] = existing ? [] : await tx.insert(actionAttempts).values({
        contactId: target.contactId, action: target.action, idempotencyKey: key, status: "running",
        result: { version: 1, target, phase: "reserved" } satisfies EngagementRecord,
      }).onConflictDoNothing().returning();
      const row = created ?? existing;
      if (!row || row.action !== target.action || !sameEngagementTarget(engagementRecordSchema.parse(row.result).target, target)) {
        throw new Error("Engagement claim identity conflict");
      }
      return { acquired: Boolean(created), id: row.id };
    });
  }

  async read(id: string) {
    z.string().uuid().parse(id);
    const [row] = await this.db.select().from(actionAttempts).where(eq(actionAttempts.id, id));
    if (!row || !["follow", "comment_1", "comment_2", "comment_3", "dm"].includes(row.action)) throw new Error("Unknown engagement request");
    return { ...row, data: engagementRecordSchema.parse(row.result) };
  }
  async progress(id: string) {
    const row = await this.read(id);
    return { id, action: row.data.target.action,
      state: row.status === "paused" ? "paused" : row.status === "cancelled" ? "cancelled" : row.data.phase === "complete" ? "succeeded" : row.data.phase,
      ...(row.providerRunId ? { providerRunId: row.providerRunId } : {}), ...(row.errorCode ? { reason: row.errorCode } : {}),
      ...(row.data.providerOutcome ? { providerOutcome: row.data.providerOutcome } : {}),
      ...(row.costUsd ? { costUsd: row.costUsd } : {}) };
  }
  async linkWorkflow(id: string, workflowRunId: string) {
    z.string().min(1).max(250).parse(workflowRunId);
    await this.db.update(actionAttempts).set({ result: sql`${actionAttempts.result} || ${JSON.stringify({ workflowRunId })}::jsonb`, updatedAt: new Date() })
      .where(eq(actionAttempts.id, id));
  }
  async beginStart(id: string) {
    const [row] = await this.db.update(actionAttempts).set({
      result: sql`${actionAttempts.result} || '{"phase":"starting"}'::jsonb`, updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, id), eq(actionAttempts.status, "running"), sql`${actionAttempts.result}->>'phase' = 'reserved'`)).returning();
    return Boolean(row);
  }
  async recordStart(id: string, providerRunId: string) {
    z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(providerRunId);
    const [row] = await this.db.update(actionAttempts).set({ providerRunId,
      result: sql`${actionAttempts.result} || '{"phase":"polling"}'::jsonb`, updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, id), eq(actionAttempts.status, "running"),
      sql`${actionAttempts.result}->>'phase' = 'starting'`, sql`${actionAttempts.providerRunId} is null`)).returning();
    if (!row) throw new Error("Could not record engagement provider reference");
  }
  async providerSuccess(id: string, costUsd?: number, providerMessageId?: string,
    providerOutcome?: EngagementRecord["providerOutcome"]) {
    z.number().finite().nonnegative().max(999999).optional().parse(costUsd);
    z.string().min(1).max(250).optional().parse(providerMessageId);
    const row = await this.read(id);
    await this.db.transaction(async (tx) => {
      const [updated] = await tx.update(actionAttempts).set({ status: "running", errorCode: null, costUsd: costUsd?.toFixed(6),
        result: sql`${actionAttempts.result} || ${JSON.stringify({ phase: "provider_succeeded", ...(providerOutcome ? { providerOutcome } : {}) })}::jsonb`, updatedAt: new Date(),
      }).where(and(eq(actionAttempts.id, id), inArray(actionAttempts.status, ["running", "paused"]),
        sql`${actionAttempts.result}->>'phase' = 'polling'`)).returning();
      if (updated && row.data.target.action === "dm") {
        const audits = await tx.update(messageAudit).set({ providerMessageId, sentAt: new Date(), updatedAt: new Date() })
          .where(and(eq(messageAudit.contactId, row.contactId), eq(messageAudit.kind, `dm:${row.data.target.approvalBatchId}`),
            eq(messageAudit.messageText, row.data.target.text))).returning({ id: messageAudit.id });
        if (audits.length !== 1) throw new Error("DM audit identity mismatch");
      }
    });
  }
  async providerFailure(id: string, costUsd?: number) {
    z.number().finite().nonnegative().max(999999).optional().parse(costUsd);
    await this.db.update(actionAttempts).set({ status: "cancelled", errorCode: "provider_failed",
      costUsd: costUsd?.toFixed(6), updatedAt: new Date() }).where(and(
      eq(actionAttempts.id, id), inArray(actionAttempts.status, ["running", "paused"]),
      sql`${actionAttempts.result}->>'phase' = 'polling'`,
    ));
  }
  async complete(id: string) {
    await this.db.update(actionAttempts).set({ status: "succeeded", errorCode: null,
      result: sql`${actionAttempts.result} || '{"phase":"complete"}'::jsonb`, updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, id), inArray(actionAttempts.status, ["running", "paused"]),
      sql`${actionAttempts.result}->>'phase' = 'provider_succeeded'`));
  }
  async pause(id: string, reason: string, phases: EngagementRecord["phase"][], options: { tripCircuit?: boolean; costUsd?: number } = {}) {
    z.string().regex(/^[a-z_]{1,80}$/).parse(reason); z.number().finite().nonnegative().max(999999).optional().parse(options.costUsd);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.update(actionAttempts).set({ status: "paused", errorCode: reason, costUsd: options.costUsd?.toFixed(6), updatedAt: new Date() })
        .where(and(eq(actionAttempts.id, id), inArray(actionAttempts.status, ["running", "paused"]),
          inArray(sql<string>`${actionAttempts.result}->>'phase'`, phases))).returning();
      if (row && options.tripCircuit) {
        const action = engagementRecordSchema.parse(row.result).target.action;
        const value = { disabled: true, reason: `instagram_${action}_${reason}` };
        await tx.insert(settings).values({ key: `outbound_disabled:${switchFor(action)}`, value, updatedBy: "instagram_engagement_circuit" })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: "instagram_engagement_circuit", updatedAt: new Date() } });
      }
    });
  }
  async cancelPausedUnknown(id: string, providerRunId: string) {
    z.string().uuid().parse(id);
    z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(providerRunId);
    const [row] = await this.db.update(actionAttempts).set({
      status: "cancelled", errorCode: "operator_cancelled", updatedAt: new Date(),
    }).where(and(
      eq(actionAttempts.id, id), eq(actionAttempts.status, "paused"), eq(actionAttempts.errorCode, "provider_unknown"),
      eq(actionAttempts.providerRunId, providerRunId), sql`${actionAttempts.result}->>'phase' = 'polling'`,
    )).returning({ id: actionAttempts.id });
    if (!row) throw new Error("Paused unknown engagement does not match");
    return this.progress(id);
  }
}

export function completedTagForAction(action: EngagementAction) {
  return ({ follow: "ig-followed", comment_1: "ig-comment-1", comment_2: "ig-comment-2", comment_3: "ig-comment-3", dm: "ig-dm-sent" } as const)[action];
}
