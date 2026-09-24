import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { LikeBatchRepository } from "@/lib/db/like-batches";
import { LikeRepository } from "@/lib/db/likes";
import { actionAttempts, workflowRuns } from "@/lib/db/schema";
import { batchConfigSchema, type BatchState } from "@/lib/likes/batch-contracts";
import { rollingInstagramActions } from "@/lib/db/instagram-budget";
const client = new PGlite(); const db = drizzle(client); const batches = new LikeBatchRepository(db);
const state = (accountId: string): BatchState => ({ version: 1, accountId, accountUsername: "account", mode: "execute",
  profileFieldId: "profile", cursor: 0, nextAt: new Date().toISOString(), limits: batchConfigSchema.parse({}),
  items: [{ contactId: "contact", username: "trainer", phase: "ready", polls: 0, postUrl: "https://www.instagram.com/reel/Test/" }] });
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });
describe("durable session state and activity limits", () => {
  it("deduplicates session requests and blocks overlapping or paused account sessions", async () => {
    const key = randomUUID(); const result = await batches.create(key, state("501"));
    expect(await batches.create(key, state("501"))).toEqual({ acquired: false, id: result.id });
    await expect(batches.create(randomUUID(), state("501"))).rejects.toThrow("session");
    await batches.pause(result.id, "lost_provider_response");
    await expect(batches.create(randomUUID(), state("501"))).rejects.toThrow("session");
    expect((await batches.list()).find((row) => row.id === result.id)).toMatchObject({ needsAttention: true, reason: "lost_provider_response" });
  });
  it("only allows persisted current-item targets and counts failed attempts from all action types", async () => {
    const s = state("502"); s.limits.IG_ROLLING_DAY_ACTION_LIMIT = 2;
    const { id } = await batches.create(randomUUID(), s);
    const target = { accountId: "502", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl! };
    const likes = new LikeRepository(db);
    await expect(likes.claim({ ...target, postUrl: "https://www.instagram.com/reel/Wrong/" }, { sessionId: id })).rejects.toThrow("authorized");
    for (const [i, action] of ["follow", "comment_1"].entries()) await db.insert(actionAttempts).values({
      contactId: "other", action, idempotencyKey: `fixture:${i}`, status: "failed", result: { target: { accountId: "502" } } });
    expect(await rollingInstagramActions(db, "502")).toBe(2);
    await expect(likes.claim(target, { sessionId: id })).rejects.toThrow("limit");
    await expect(likes.claim(target)).rejects.toThrow("session");
  });
  it("preserves a claim across replay and blocks new posts after an unresolved outcome", async () => {
    const s = state("503"); const { id } = await batches.create(randomUUID(), s); const likes = new LikeRepository(db);
    const target = { accountId: "503", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl! };
    const first = await likes.claim(target, { sessionId: id });
    expect(await likes.claim(target, { sessionId: id })).toMatchObject({ acquired: false, id: first.id });
    await likes.beginStart(first.id);
    await expect(likes.claim({ ...target, postUrl: "https://www.instagram.com/reel/Another/" }, { sessionId: id })).rejects.toThrow("unresolved");
  });
  it("increments confirmed no-post outcomes exactly once and stops at three", async () => {
    for (let n = 1; n <= 3; n++) {
      const s = state("504"); s.items[0].phase = "scrape_polling";
      const { id } = await batches.create(randomUUID(), s);
      await batches.recordNoPost(id, 0); await batches.recordNoPost(id, 0);
      expect(await batches.noPostCount("504", "contact")).toBe(n);
      await batches.change(id, () => {}, "succeeded");
    }
  });
  it("reports overdue work separately from a legitimate durable wait", async () => {
    const s = state("505"); s.nextAt = new Date(Date.now() + 3600000).toISOString();
    const { id } = await batches.create(randomUUID(), s);
    await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() - 3600000) }).where(eq(workflowRuns.id, id));
    expect((await batches.list()).find((row) => row.id === id)?.needsAttention).toBe(false);
    await batches.change(id, (data) => { data.nextAt = new Date(Date.now() - 3600000).toISOString(); });
    await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() - 3600000) }).where(eq(workflowRuns.id, id));
    expect((await batches.list()).find((row) => row.id === id)).toMatchObject({ needsAttention: true, reason: "stalled_session" });
  });
  it("recovers a committed but undispatched overdue session exactly once without shortening its wait", async () => {
    const s = state("512"); s.items[0].phase = "queued"; s.nextAt = new Date(Date.now() + 3600000).toISOString();
    const { id } = await batches.create(randomUUID(), s);
    await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() - 3600000) }).where(eq(workflowRuns.id, id));
    expect(await batches.resume(id)).toBe(false);
    const due = new Date(Date.now() - 3600000).toISOString();
    await batches.change(id, (data) => { data.nextAt = due; });
    await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() - 3600000) }).where(eq(workflowRuns.id, id));
    expect((await Promise.all([batches.resume(id), batches.resume(id)])).filter(Boolean)).toHaveLength(1);
    expect((await batches.read(id)).state.nextAt).toBe(due);
    expect((await batches.list()).find((row) => row.id === id)?.needsAttention).toBe(false);
  });
  it("refuses recovery of an unknown start and keeps its action claim after cancellation", async () => {
    const s = state("506"); const { id } = await batches.create(randomUUID(), s);
    const likes = new LikeRepository(db);
    const claim = await likes.claim({ accountId: "506", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl! }, { sessionId: id });
    await batches.change(id, (data) => { data.items[0].actionId = claim.id; data.items[0].phase = "like_active"; });
    await likes.beginStart(claim.id); await batches.pause(id, "unknown");
    await expect(batches.resume(id)).rejects.toThrow("must not be restarted");
    await batches.cancel(id);
    expect((await likes.read(claim.id)).data.phase).toBe("starting");
    await expect(batches.create(randomUUID(), state("506"))).rejects.toThrow("unresolved");
  });
  it("resumes known provider observation without resetting the sending phase", async () => {
    const s = state("507"); const { id } = await batches.create(randomUUID(), s); const likes = new LikeRepository(db);
    const claim = await likes.claim({ accountId: "507", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl! }, { sessionId: id });
    await likes.beginStart(claim.id); await likes.recordStart(claim.id, "known-run");
    await batches.change(id, (data) => { data.items[0].actionId = claim.id; data.items[0].phase = "like_active"; });
    await batches.pause(id, "observation_timeout");
    expect(await batches.resume(id)).toBe(true); expect(await batches.resume(id)).toBe(false);
    expect((await likes.read(claim.id)).data.phase).toBe("polling");
  });
  it("recovers the same paused pre-send reservation without creating another claim", async () => {
    const s = state("509"); const { id } = await batches.create(randomUUID(), s); const likes = new LikeRepository(db);
    const target = { accountId: "509", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl! };
    const claim = await likes.claim(target, { sessionId: id });
    await batches.change(id, (data) => { data.items[0].actionId = claim.id; data.items[0].phase = "like_active"; });
    await likes.pause(claim.id, "not_authorized", ["reserved"]); await batches.pause(id, "action_paused");
    expect(await batches.resume(id)).toBe(true);
    expect(await likes.read(claim.id)).toMatchObject({ status: "running", providerRunId: null, errorCode: null, data: { phase: "reserved" } });
    expect(await likes.claim(target, { sessionId: id })).toEqual({ acquired: false, id: claim.id });
    expect(await likes.beginStart(claim.id)).toBe(true); expect(await likes.beginStart(claim.id)).toBe(false);
  });
  it("atomically attaches a reservation and cancels only unsent work while retaining deduplication", async () => {
    const s = state("510"); const { id } = await batches.create(randomUUID(), s); const likes = new LikeRepository(db);
    const target = { accountId: "510", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl! };
    const claim = await likes.claim(target, { sessionId: id });
    expect((await batches.read(id)).state.items[0]).toMatchObject({ actionId: claim.id, phase: "like_active" });
    expect(await batches.cancel(id)).toBe("cancelled");
    expect(await likes.progress(claim.id)).toMatchObject({ state: "cancelled" });
    expect(await likes.beginStart(claim.id)).toBe(false);
    expect(await likes.claim(target)).toEqual({ acquired: false, id: claim.id });
    expect(await rollingInstagramActions(db, "510")).toBe(1);
    expect((await batches.create(randomUUID(), state("510"))).acquired).toBe(true);
  });
  it("cancels an older orphaned pre-send reservation by session identity", async () => {
    const s = state("511"); const { id } = await batches.create(randomUUID(), s); const likes = new LikeRepository(db);
    const claim = await likes.claim({ accountId: "511", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl! }, { sessionId: id });
    await batches.change(id, (data) => { data.items[0].phase = "ready"; delete data.items[0].actionId; });
    await batches.cancel(id);
    expect(await likes.progress(claim.id)).toMatchObject({ state: "cancelled" });
    expect((await batches.create(randomUUID(), state("511"))).acquired).toBe(true);
  });
  it("counts delayed actions in the current budget window rather than only their original reservation date", async () => {
    await db.insert(actionAttempts).values({ contactId: "contact", action: "like", idempotencyKey: "old-reservation-new-completion", status: "succeeded",
      result: { target: { accountId: "508" } }, createdAt: new Date(Date.now() - 2 * 86400000), updatedAt: new Date() });
    expect(await rollingInstagramActions(db, "508")).toBe(1);
  });
});

