import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { FailureAlertRepository, OUTREACH_REPORT_CHANNEL } from "@/lib/likes/failure-alerts";
import { LikeBatchRepository } from "@/lib/db/like-batches";
import { batchConfigSchema, type BatchState } from "@/lib/likes/batch-contracts";
import { actionAttempts, monitoringAlerts, workflowRuns } from "@/lib/db/schema";
import { ProviderError } from "@/lib/clients/errors";
const client = new PGlite(); const db = drizzle(client); const alerts = new FailureAlertRepository(db); const batches = new LikeBatchRepository(db);
let serial = 10000;
const state = (): BatchState => ({ version: 1, accountId: String(serial++), accountUsername: "account", mode: "preview", profileFieldId: "profile",
  cursor: 0, nextAt: new Date().toISOString(), limits: batchConfigSchema.parse({}), items: [{ contactId: "contact", username: "trainer", phase: "queued", polls: 0 }] });
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });
it("deduplicates a pause, survives late provider evidence, and alerts a new pause after recovery", async () => {
  const { id } = await batches.create(randomUUID(), state()); await batches.pause(id, "scrape_timeout");
  expect(await alerts.collect()).toBe(1); expect(await alerts.collect()).toBe(0);
  await batches.linkWorkflow(id, "late-dispatch-reference"); expect(await alerts.collect()).toBe(0);
  await batches.resume(id); await batches.pause(id, "scrape_timeout"); expect(await alerts.collect()).toBe(1);
  await batches.cancel(id);
});
it("respects scheduled wake times and reports overdue work once without needing an Instagram gate", async () => {
  const s = state(); s.nextAt = new Date(Date.now() + 3600000).toISOString(); const { id } = await batches.create(randomUUID(), s);
  await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() - 3600000) }).where(eq(workflowRuns.id, id));
  expect(await alerts.collect()).toBe(0);
  await batches.change(id, (data) => { data.nextAt = new Date(Date.now() - 3600000).toISOString(); });
  await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() - 3600000) }).where(eq(workflowRuns.id, id));
  expect(await alerts.collect()).toBe(1); expect(await alerts.collect()).toBe(0); await batches.cancel(id);
});
it("never sends raw error text and does not notify healthy or cancelled sessions", async () => {
  const { id } = await batches.create(randomUUID(), state()); expect(await alerts.collect()).toBe(0);
  await batches.pause(id, "private token must not appear"); expect(await alerts.collect()).toBe(1);
  const rows = await db.select().from(monitoringAlerts);
  expect(JSON.stringify(rows.map((r) => r.payload))).not.toContain("private token"); await batches.cancel(id);
});
it("sends each pending alert only once across overlapping checks and deduplicates test requests", async () => {
  const request = randomUUID(); const id = await alerts.test(request); expect(await alerts.test(request)).toBe(id);
  const send = vi.fn(async () => ({ channel: "DPRIVATE", messageId: "123.456" }));
  const sink = { channelId: "DPRIVATE", enabled: () => true, send };
  const before = (await db.select().from(monitoringAlerts)).filter((r) => r.status === "pending").length;
  await Promise.all([alerts.drain(sink), alerts.drain(sink)]);
  expect(send).toHaveBeenCalledTimes(before); expect(await alerts.read(id)).toMatchObject({ status: "sent", messageId: "123.456" });
  await alerts.drain(sink); expect(send).toHaveBeenCalledTimes(before);
});
it("keeps uncertain delivery visible and never retries it automatically", async () => {
  const id = await alerts.test(randomUUID()); const send = vi.fn(async () => { throw new Error("response lost"); });
  expect(await alerts.drain({ channelId: "DPRIVATE", enabled: () => true, send })).toMatchObject({ uncertain: 1 });
  expect(await alerts.read(id)).toMatchObject({ status: "unknown" });
  expect(await alerts.drain({ channelId: "DPRIVATE", enabled: () => true, send })).toMatchObject({ uncertain: 1 }); expect(send).toHaveBeenCalledTimes(1);
});
it("keeps a definitive Slack rejection pending so the same alert can send on the next cron", async () => {
  const id = await alerts.test(randomUUID());
  const rejected = vi.fn(async () => { throw new ProviderError("slack", "authentication", 401); });
  expect(await alerts.drain({ channelId: "DPRIVATE", enabled: () => true, send: rejected })).toMatchObject({ sent: 0 });
  expect(await alerts.read(id)).toMatchObject({ status: "pending" });
  const recovered = vi.fn(async () => ({ channel: "DPRIVATE", messageId: "2.2" }));
  expect(await alerts.drain({ channelId: "DPRIVATE", enabled: () => true, send: recovered })).toMatchObject({ sent: 1 });
  expect(await alerts.read(id)).toMatchObject({ status: "sent", messageId: "2.2" });
  expect(rejected).toHaveBeenCalledTimes(1); expect(recovered).toHaveBeenCalledTimes(1);
});
it("converts an abandoned delivery claim to uncertainty, while disabled checks leave pending alerts intact", async () => {
  const id = await alerts.test(randomUUID()); const send = vi.fn(async () => ({ channel: "DPRIVATE", messageId: "1.1" }));
  await alerts.drain({ channelId: "DPRIVATE", enabled: () => false, send }); expect((await alerts.read(id)).status).toBe("pending"); expect(send).not.toHaveBeenCalled();
  await db.update(monitoringAlerts).set({ status: "sending", updatedAt: new Date(Date.now() - 3600000) }).where(eq(monitoringAlerts.id, id));
  await alerts.drain({ channelId: "DPRIVATE", enabled: () => true, send }); expect((await alerts.read(id)).status).toBe("unknown"); expect(send).not.toHaveBeenCalled();
});
it("builds one deduplicated count-only daily summary for the Sydney date", async () => {
  await db.insert(actionAttempts).values([
    { contactId: "daily-follow", action: "follow", idempotencyKey: "daily-follow", status: "succeeded", createdAt: new Date("2026-09-17T06:00:00Z") },
    { contactId: "daily-comment", action: "comment_1", idempotencyKey: "daily-comment", status: "paused", createdAt: new Date("2026-09-17T06:05:00Z") },
    { contactId: "daily-dm", action: "dm", idempotencyKey: "daily-dm", status: "cancelled", createdAt: new Date("2026-09-17T06:10:00Z") },
  ]);
  const first = await alerts.enqueueDailySummary(new Date("2026-09-17T07:00:00Z"));
  expect(await alerts.enqueueDailySummary(new Date("2026-09-17T07:30:00Z"))).toBe(first);
  const [row] = (await db.select().from(monitoringAlerts)).filter((value) => value.kind === "instagram_daily_summary");
  expect(JSON.stringify(row.payload)).toContain("Daily report for 2026-09-17");
  expect(JSON.stringify(row.payload)).toContain('Instagram follows: 1; status {\\"succeeded\\":1}');
  expect(JSON.stringify(row.payload)).toContain('Instagram comments: 1; status {\\"paused\\":1}');
  expect(JSON.stringify(row.payload)).toContain('Instagram DMs: 1; status {\\"cancelled\\":1}');
  expect(JSON.stringify(row.payload)).toContain("Operational incidents:");
  const send = vi.fn(async () => ({ channel: OUTREACH_REPORT_CHANNEL, messageId: "5.5" }));
  expect(await alerts.drain({ channelId: OUTREACH_REPORT_CHANNEL, enabled: () => true, send }, "instagram_daily_summary")).toMatchObject({ sent: 1 });
});

