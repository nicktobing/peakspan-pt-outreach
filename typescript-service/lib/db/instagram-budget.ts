import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { actionAttempts, settings } from "./schema";

export async function lockInstagramAccount(db: PgDatabase<PgQueryResultHKT>, accountId: string) {
  const key = `ig_account_lock:${accountId}`;
  await db.insert(settings).values({ key, value: {}, updatedBy: "instagram_budget" }).onConflictDoNothing();
  await db.select().from(settings).where(eq(settings.key, key)).for("update");
}
// All implemented Instagram writers must reserve under the same account lock.
// Count attempted actions, including failed/unknown actions, not only successes.
export async function rollingInstagramActions(db: PgDatabase<PgQueryResultHKT>, accountId: string, now = new Date()) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(actionAttempts).where(and(
    inArray(actionAttempts.action, ["like", "follow", "comment_1", "comment_2", "comment_3", "dm"]),
    sql`${actionAttempts.result}->'target'->>'accountId' = ${accountId}`,
    // Late resumptions/reconciliation still consume the current window.
    gte(actionAttempts.updatedAt, new Date(now.getTime() - 86400000)),
  ));
  return row.count;
}
export async function unresolvedInstagramAction(db: PgDatabase<PgQueryResultHKT>, accountId: string) {
  const [row] = await db.select({ id: actionAttempts.id }).from(actionAttempts).where(and(
    inArray(actionAttempts.action, ["like", "follow", "comment_1", "comment_2", "comment_3", "dm"]),
    inArray(actionAttempts.status, ["running", "paused"]), sql`${actionAttempts.result}->'target'->>'accountId' = ${accountId}`,
  )).limit(1);
  return Boolean(row);
}

