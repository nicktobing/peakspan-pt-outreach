import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { actionAttempts, settings, workflowRuns } from "./schema";
import { lockInstagramAccount, unresolvedInstagramAction } from "./instagram-budget";
import { batchStateSchema, type BatchState } from "../likes/batch-contracts";
import { LikeRepository } from "./likes";

export const LIKE_BATCH_WORKFLOW = "instagram_like_batch";
function overdue(updatedAt: Date, state: BatchState) {
  return Date.now() > Math.max(updatedAt.getTime(), Date.parse(state.nextAt)) + 15 * 60000;
}
export class LikeBatchRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}
  async create(requestId: string, input: BatchState) {
    z.uuid().parse(requestId); const state = batchStateSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await lockInstagramAccount(tx, state.accountId);
      const [duplicate] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW), eq(workflowRuns.scheduledWindow, requestId)));
      if (duplicate) return { acquired: false, id: duplicate.id };
      const [active] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW),
        inArray(workflowRuns.status, ["pending", "running", "paused"]), sql`${workflowRuns.result}->>'accountId' = ${state.accountId}`));
      if (active) throw new Error("An account session already requires completion or attention");
      if (state.mode === "execute" && await unresolvedInstagramAction(tx, state.accountId)) throw new Error("Account has an unresolved action");
      const [row] = await tx.insert(workflowRuns).values({ workflow: LIKE_BATCH_WORKFLOW, workflowRunId: requestId,
        scheduledWindow: requestId, status: "running", result: state, startedAt: new Date() }).returning();
      return { acquired: true, id: row.id };
    });
  }
  async read(id: string) {
    z.uuid().parse(id);
    const [row] = await this.db.select().from(workflowRuns).where(and(eq(workflowRuns.id, id), eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW)));
    if (!row) throw new Error("Unknown Instagram session");
    return { ...row, state: batchStateSchema.parse(row.result) };
  }
  async change(id: string, apply: (state: BatchState) => void, status?: "running" | "paused" | "succeeded" | "cancelled") {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, id), eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW))).for("update");
      if (!row) throw new Error("Unknown session");
      if (row.status !== "running") return false;
      const state = batchStateSchema.parse(row.result); apply(state);
      if (status === "paused") state.attentionAt = new Date().toISOString();
      await tx.update(workflowRuns).set({ result: batchStateSchema.parse(state), updatedAt: new Date(),
        ...(status ? { status, ...(status === "succeeded" || status === "cancelled" ? { endedAt: new Date() } : {}) } : {}) }).where(eq(workflowRuns.id, id));
      return true;
    });
  }
  async pause(id: string, reason: string) { await this.change(id, (state) => { state.reason = reason; }, "paused"); }
  async linkWorkflow(id: string, workflowRunId: string) {
    await this.db.update(workflowRuns).set({ workflowRunId, updatedAt: new Date() }).where(and(eq(workflowRuns.id, id), eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW)));
  }
  async recordScrapeStart(id: string, index: number, runId: string) {
    z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(runId);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, id), eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW))).for("update");
      if (!row) throw new Error("Unknown session");
      const state = batchStateSchema.parse(row.result); const item = state.items[index];
      if (!item || state.cursor !== index) throw new Error("Scraper item mismatch");
      if (item.scrapeRunId === runId) return;
      if (item.phase !== "scrape_starting" || item.scrapeRunId) throw new Error("Scraper reference conflict");
      item.scrapeRunId = runId; item.phase = "scrape_polling";
      // Preserve a returned reference even when pause/cancel wins during the HTTP request.
      // Recording evidence never reopens the session or starts another provider request.
      await tx.update(workflowRuns).set({ result: state, updatedAt: new Date() }).where(eq(workflowRuns.id, id));
    });
  }
  async cancel(id: string) {
    z.uuid().parse(id);
    const initial = await this.read(id);
    return this.db.transaction(async (tx) => {
      await lockInstagramAccount(tx, initial.state.accountId);
      const [row] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, id)).for("update");
      if (!["pending", "running", "paused"].includes(row.status)) return row.status;
      // beginStart competes on the same action row: only provably unsent claims can close.
      // Keep the rows for deduplication and conservative budget accounting.
      await tx.update(actionAttempts).set({ status: "cancelled", errorCode: "session_cancelled", updatedAt: new Date() }).where(and(
        eq(actionAttempts.action, "like"), inArray(actionAttempts.status, ["running", "paused"]),
        sql`${actionAttempts.result}->>'sessionId' = ${id}`, sql`${actionAttempts.result}->>'phase' = 'reserved'`,
        sql`${actionAttempts.providerRunId} is null`));
      await tx.update(workflowRuns).set({ status: "cancelled", endedAt: new Date(), updatedAt: new Date() }).where(eq(workflowRuns.id, id));
      return "cancelled" as const;
    });
  }
  async resume(id: string) {
    z.uuid().parse(id);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, id), eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW))).for("update");
      if (!row) return false;
      const state = batchStateSchema.parse(row.result);
      if (row.status !== "paused" && !(row.status === "running" && overdue(row.updatedAt, state))) return false;
      const item = state.items[state.cursor];
      if (item?.phase === "scrape_starting") throw new Error("Unknown scraper start requires manual reconciliation");
      if (item?.phase === "like_active") {
        if (!item.actionId) throw new Error("Missing action reference");
        await tx.select({ id: actionAttempts.id }).from(actionAttempts).where(eq(actionAttempts.id, item.actionId)).for("update");
        const action = await new LikeRepository(tx).read(item.actionId);
        if (action.data.sessionId !== id || action.data.target.accountId !== state.accountId ||
          action.data.target.accountUsername !== state.accountUsername || action.data.target.contactId !== item.contactId ||
          action.data.target.targetUsername !== item.username || action.data.target.postUrl !== item.postUrl) throw new Error("Action identity mismatch");
        if (action.data.phase === "reserved" && !action.providerRunId && ["running", "paused"].includes(action.status)) {
          // No provider call can precede the persisted starting transition.
          await tx.update(actionAttempts).set({ status: "running", errorCode: null, updatedAt: new Date() }).where(eq(actionAttempts.id, item.actionId));
        } else if (!["polling", "provider_succeeded", "complete"].includes(action.data.phase) || !action.providerRunId) throw new Error("Unknown action must not be restarted");
      }
      state.reason = undefined;
      state.attentionAt = undefined;
      if (item) item.polls = 0;
      await tx.update(workflowRuns).set({ status: "running", result: state, updatedAt: new Date() }).where(eq(workflowRuns.id, id));
      return true;
    });
  }
  async list() {
    const rows = await this.db.select().from(workflowRuns).where(eq(workflowRuns.workflow, LIKE_BATCH_WORKFLOW)).orderBy(desc(workflowRuns.createdAt)).limit(100);
    return rows.map((row) => {
      const state = batchStateSchema.parse(row.result);
      const stalled = row.status === "running" && overdue(row.updatedAt, state);
      return { id: row.id, status: row.status, mode: state.mode, cursor: state.cursor, total: state.items.length,
        needsAttention: row.status === "paused" || stalled, reason: stalled ? "stalled_session" : state.reason,
        updatedAt: row.updatedAt, nextAt: state.nextAt };
    });
  }
  async noPostCount(accountId: string, contactId: string) {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, `ig_no_post:${accountId}:${contactId}`));
    return row ? z.number().int().min(0).max(3).parse(row.value) : 0;
  }
  async recordNoPost(id: string, index: number) {
    // Count only confirmed empty selections; replay cannot increment twice.
    return this.db.transaction(async (tx) => {
      const repo = new LikeBatchRepository(tx);
      const [row] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, id)).for("update");
      const state = batchStateSchema.parse(row.result); const item = state.items[index];
      if (row.status !== "running" || item.phase !== "scrape_polling") return;
      const key = `ig_no_post:${state.accountId}:${item.contactId}`;
      const count = Math.min(3, await repo.noPostCount(state.accountId, item.contactId) + 1);
      await tx.insert(settings).values({ key, value: count, updatedBy: "instagram_selection" }).onConflictDoUpdate({ target: settings.key, set: { value: count, updatedAt: new Date() } });
      item.phase = "skipped"; item.reason = count >= 3 ? "no_post_three_attempts" : "no_recent_owned_or_collab_post";
      await tx.update(workflowRuns).set({ result: state, updatedAt: new Date() }).where(eq(workflowRuns.id, id));
    });
  }
}

