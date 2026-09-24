import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { actionAttempts, settings, workflowRuns } from "./schema";
import { lockInstagramAccount, rollingInstagramActions, unresolvedInstagramAction } from "./instagram-budget";
import { batchConfig, batchStateSchema } from "../likes/batch-contracts";
import { idempotencyKey } from "../domain/idempotency";
import { instagramPost, likeRecordSchema, likeTargetSchema, sameTarget, type LikeProgress, type LikeRecord, type LikeTarget } from "../likes/contracts";

export class LikeRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}

  async claim(value: LikeTarget, options: { sessionId?: string } = {}) {
    const target = likeTargetSchema.parse(value);
    const key = idempotencyKey("instagram-like", target.accountId, instagramPost(target.postUrl).shortcode);
    return this.db.transaction(async (tx) => {
    await lockInstagramAccount(tx, target.accountId);
    const [existing] = await tx.select().from(actionAttempts).where(eq(actionAttempts.idempotencyKey, key));
    if (!existing && await unresolvedInstagramAction(tx, target.accountId)) throw new Error("Account has an unresolved action");
    let limit = batchConfig().IG_ROLLING_DAY_ACTION_LIMIT;
    const sessions = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.workflow, "instagram_like_batch"),
      inArray(workflowRuns.status, ["running", "pending", "paused"]), sql`${workflowRuns.result}->>'accountId' = ${target.accountId}`)).for("update");
    if (existing && options.sessionId && likeRecordSchema.parse(existing.result).sessionId !== options.sessionId) {
      const session = sessions.find((entry) => entry.id === options.sessionId && entry.status === "running");
      if (!session) throw new Error("Session is unavailable");
      const state = batchStateSchema.parse(session.result); const item = state.items[state.cursor];
      const prior = likeRecordSchema.parse(existing.result);
      if (existing.action !== "like" || prior.target.accountId !== target.accountId ||
        instagramPost(prior.target.postUrl).shortcode !== instagramPost(target.postUrl).shortcode ||
        state.mode !== "execute" || state.accountUsername !== target.accountUsername || item?.phase !== "ready" ||
        item.contactId !== target.contactId || item.username !== target.targetUsername || item.postUrl !== target.postUrl) throw new Error("Like claim identity conflict");
      // Another contact may legitimately select the same collaboration post.
      // Report a duplicate without attaching or executing that contact's action.
      return { acquired: false, id: existing.id, duplicatePost: true as const };
    }
    if (!existing && sessions.length && !options.sessionId) throw new Error("An account session is active");
    if (!existing && options.sessionId) {
      const session = sessions.find((row) => row.id === options.sessionId && row.status === "running");
      if (!session) throw new Error("Session is unavailable");
      const state = batchStateSchema.parse(session.result); const item = state.items[state.cursor];
      if (state.mode !== "execute" || item?.phase !== "ready" || item.contactId !== target.contactId ||
        item.username !== target.targetUsername || item.postUrl !== target.postUrl || state.accountUsername !== target.accountUsername ||
        state.items.filter((entry) => entry.actionId).length >= state.limits.IG_SESSION_ACTION_LIMIT) throw new Error("Session action is not authorized");
      limit = Math.min(limit, state.limits.IG_ROLLING_DAY_ACTION_LIMIT);
    }
    if (!existing && await rollingInstagramActions(tx, target.accountId) >= limit) throw new Error("Rolling account action limit reached");
    const [created] = existing ? [] : await tx.insert(actionAttempts).values({ contactId: target.contactId, action: "like", idempotencyKey: key,
      status: "running", result: { version: 1, target, phase: "reserved", ...options } satisfies LikeRecord }).onConflictDoNothing().returning();
    const row = created ?? existing;
    if (!row || row.action !== "like" || !sameTarget(likeRecordSchema.parse(row.result).target, target)) throw new Error("Like claim identity conflict");
    if (options.sessionId && likeRecordSchema.parse(row.result).sessionId === options.sessionId) {
      const session = sessions.find((entry) => entry.id === options.sessionId && entry.status === "running");
      if (!session) throw new Error("Session is unavailable");
      const state = batchStateSchema.parse(session.result); const item = state.items[state.cursor];
      if (item?.phase === "ready" && item.contactId === target.contactId && item.username === target.targetUsername && item.postUrl === target.postUrl) {
        item.actionId = row.id; item.phase = "like_active";
        await tx.update(workflowRuns).set({ result: state, updatedAt: new Date() }).where(eq(workflowRuns.id, session.id));
      }
    }
    return { acquired: Boolean(created), id: row.id };
    });
  }
  async read(id: string) {
    z.string().uuid().parse(id);
    const [row] = await this.db.select().from(actionAttempts).where(and(eq(actionAttempts.id, id), eq(actionAttempts.action, "like")));
    if (!row) throw new Error("Unknown like request");
    return { ...row, data: likeRecordSchema.parse(row.result) };
  }
  async progress(id: string): Promise<LikeProgress> {
    const row = await this.read(id);
    return { id, state: row.status === "cancelled" ? "cancelled" : row.status === "paused" ? "paused" : row.data.phase === "complete" ? "succeeded" : row.data.phase,
      ...(row.providerRunId ? { providerRunId: row.providerRunId } : {}),
      ...(row.data.providerStatus ? { providerStatus: row.data.providerStatus } : {}),
      ...(row.errorCode ? { reason: row.errorCode } : {}), ...(row.costUsd ? { costUsd: row.costUsd } : {}) };
  }
  async linkWorkflow(id: string, workflowRunId: string) {
    z.string().min(1).max(250).parse(workflowRunId);
    await this.db.update(actionAttempts).set({ result: sql`${actionAttempts.result} || ${JSON.stringify({ workflowRunId })}::jsonb`, updatedAt: new Date() })
      .where(and(eq(actionAttempts.id, id), eq(actionAttempts.action, "like")));
  }
  async beginStart(id: string) {
    const [row] = await this.db.update(actionAttempts).set({
      result: sql`${actionAttempts.result} || '{"phase":"starting"}'::jsonb`, updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, id), eq(actionAttempts.action, "like"), eq(actionAttempts.status, "running"),
      sql`${actionAttempts.result}->>'phase' = 'reserved'`)).returning();
    return Boolean(row);
  }
  async recordStart(id: string, providerRunId: string) {
    z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(providerRunId);
    const [row] = await this.db.update(actionAttempts).set({ providerRunId,
      result: sql`${actionAttempts.result} || '{"phase":"polling"}'::jsonb`, updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, id), eq(actionAttempts.status, "running"),
      sql`${actionAttempts.result}->>'phase' = 'starting'`, sql`${actionAttempts.providerRunId} is null`)).returning();
    if (!row) throw new Error("Could not record like provider reference");
  }
  async providerSuccess(id: string, costUsd?: number) {
    z.number().finite().nonnegative().max(999999).optional().parse(costUsd);
    await this.db.update(actionAttempts).set({ status: "running", errorCode: null, costUsd: costUsd?.toFixed(6),
      result: sql`${actionAttempts.result} || '{"phase":"provider_succeeded","providerStatus":"success"}'::jsonb`, updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, id), inArray(actionAttempts.status, ["running", "paused"]),
      sql`${actionAttempts.result}->>'phase' = 'polling'`));
  }
  async complete(id: string) {
    await this.db.update(actionAttempts).set({ status: "succeeded", errorCode: null,
      result: sql`${actionAttempts.result} || '{"phase":"complete"}'::jsonb`, updatedAt: new Date(),
    }).where(and(eq(actionAttempts.id, id), inArray(actionAttempts.status, ["running", "paused"]),
      sql`${actionAttempts.result}->>'phase' = 'provider_succeeded'`));
  }
  async pause(id: string, reason: string, phases: LikeRecord["phase"][], options: {
    tripCircuit?: boolean; providerStatus?: LikeRecord["providerStatus"]; costUsd?: number;
  } = {}) {
    z.string().regex(/^[a-z_]{1,80}$/).parse(reason);
    z.number().finite().nonnegative().max(999999).optional().parse(options.costUsd);
    const patch = options.providerStatus ? { providerStatus: options.providerStatus } : {};
    await this.db.transaction(async (tx) => {
      const [row] = await tx.update(actionAttempts).set({ status: "paused", errorCode: reason, costUsd: options.costUsd?.toFixed(6),
        result: sql`${actionAttempts.result} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date(),
      }).where(and(eq(actionAttempts.id, id), eq(actionAttempts.action, "like"), inArray(actionAttempts.status, ["running", "paused"]),
        inArray(sql<string>`${actionAttempts.result}->>'phase'`, phases))).returning();
      if (row && options.tripCircuit) {
        const value = { disabled: true, reason: `instagram_like_${reason}` };
        await tx.insert(settings).values({ key: "outbound_disabled:like", value, updatedBy: "instagram_like_circuit" })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: "instagram_like_circuit", updatedAt: new Date() } });
      }
    });
  }
}

