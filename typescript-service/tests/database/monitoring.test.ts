import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { MonitoringRepository } from "@/lib/db/monitoring";
import { actionAttempts, escalationQueue, inboxMessages, monitoringAlerts, suppressionEntries } from "@/lib/db/schema";
import { dispatchMonitoringCron } from "@/lib/monitoring/cron";
import { drainAlerts, executeMonitoringRun } from "@/lib/monitoring/service";
import { ProviderError } from "@/lib/clients/errors";
import type { AlertSink, IncomingReply } from "@/lib/monitoring/contracts";

const client = new PGlite(); const db = drizzle(client); const repository = new MonitoringRepository(db);
const sources = { pipelineId: "pipeline", opportunities: async () => [], replies: async (): Promise<IncomingReply[]> => [] };
const options = { enabled: () => true, businessHours: { startHour: 9, endHour: 17 } };
const noAlerts: AlertSink = { enabled: () => false, send: async () => { throw new Error("Unexpected delivery"); } };
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });

describe("monitoring persistence and workflows", () => {
  it("dispatches one business run for concurrent cron invocations", async () => {
    const start = vi.fn(async () => "workflow-fixture");
    const results = await Promise.all(Array.from({ length: 8 }, () => dispatchMonitoringCron(repository, "daily_report",
      new Date("2026-09-07T23:10:00Z"), start, { enabled: true, reportHour: 9 })));
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("does not release a window after uncertain workflow dispatch", async () => {
    const start = vi.fn(async () => { throw new Error("synthetic provider error"); });
    const now = new Date("2026-09-08T00:00:00Z");
    expect((await dispatchMonitoringCron(repository, "reply_monitor", now, start, { enabled: true, reportHour: 9 })).status).toBe("dispatch_unknown");
    expect((await dispatchMonitoringCron(repository, "reply_monitor", now, start, { enabled: true, reportHour: 9 })).status).toBe("duplicate");
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("builds a report from execution totals and an isolated GHL pipeline snapshot", async () => {
    await db.insert(actionAttempts).values([
      { contactId: "c1", action: "follow", idempotencyKey: "report-one", status: "succeeded", costUsd: "0.25", createdAt: new Date("2026-09-09T14:00:00Z") },
      { contactId: "c2", action: "follow", idempotencyKey: "report-two", status: "failed", createdAt: new Date("2026-09-10T13:59:59Z") },
      { contactId: "c3", action: "follow", idempotencyKey: "report-outside", status: "succeeded", costUsd: "100", createdAt: new Date("2026-09-10T14:00:00Z") },
    ]);
    const run = await repository.claimWindow("daily_report", "2026-09-11", new Date("2026-09-10T23:00:00Z"));
    const reportSources = { ...sources, opportunities: async () => [
      { id: "o1", pipelineId: "pipeline", pipelineStageId: "qualified" },
      { id: "o2", pipelineId: "pipeline", pipelineStageId: "identified" },
    ] };
    expect(await executeMonitoringRun(repository, run.run.id, reportSources, noAlerts, options)).toMatchObject({ processed: 2, queued: 1, sent: 0 });
    const [alert] = await db.select().from(monitoringAlerts).where(eq(monitoringAlerts.kind, "daily_report"));
    const text = (alert.payload as { text: string }).text;
    expect(text).toContain("USD 0.250000"); expect(text).toContain("1 actions with unknown cost");
    expect(text).toContain('"qualified":1'); expect(text).not.toContain("100.250000");
  });
  it("atomically records replies, suppression and one alert despite repeats", async () => {
    const reply = { providerMessageId: "fixture:reply-1", contactId: "reply-contact", receivedAt: new Date(), preview: "Private message not for alerts" };
    const created = await Promise.all(Array.from({ length: 4 }, () => repository.processReply(reply)));
    expect(created.filter(Boolean)).toHaveLength(1);
    const [suppression] = await db.select().from(suppressionEntries).where(eq(suppressionEntries.contactId, reply.contactId));
    expect(suppression.active).toBe(true);
    const [message] = await db.select().from(inboxMessages).where(eq(inboxMessages.providerMessageId, reply.providerMessageId));
    expect(message.processedAt).not.toBeNull();
    const send = vi.fn(async () => ({ messageId: "fixture-message" }));
    const sink = { enabled: () => true, send };
    await Promise.all([drainAlerts(repository, "reply_monitor", sink), drainAlerts(repository, "reply_monitor", sink)]);
    await repository.processReply(reply); await drainAlerts(repository, "reply_monitor", sink);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain(reply.preview);
  });
  it("rolls back an inbox identity conflict without suppressing the wrong contact", async () => {
    const reply = { providerMessageId: "fixture:reply-1", contactId: "wrong-contact", receivedAt: new Date(), preview: "Fixture" };
    await expect(repository.processReply(reply)).rejects.toThrow("identity mismatch");
    expect(await db.select().from(suppressionEntries).where(eq(suppressionEntries.contactId, "wrong-contact"))).toHaveLength(0);
  });
  it("keeps uncertain alert delivery from being retried", async () => {
    await repository.enqueueAlert("uncertain-alert", { kind: "reply_monitor", text: "Fixture" });
    const send = vi.fn(async () => { throw new Error("Connection lost after possible send"); });
    await drainAlerts(repository, "reply_monitor", { enabled: () => true, send });
    await drainAlerts(repository, "reply_monitor", { enabled: () => true, send });
    expect(send).toHaveBeenCalledTimes(1);
    const [alert] = await db.select().from(monitoringAlerts).where(eq(monitoringAlerts.dedupeKey, "uncertain-alert"));
    expect(alert.status).toBe("unknown");
  });
  it("retains an alert when delivery is explicitly disabled before sending", async () => {
    await repository.enqueueAlert("disabled-alert", { kind: "reply_monitor", text: "Fixture" });
    await drainAlerts(repository, "reply_monitor", { enabled: () => true, send: async () => { throw new ProviderError("slack", "disabled"); } });
    const [alert] = await db.select().from(monitoringAlerts).where(eq(monitoringAlerts.dedupeKey, "disabled-alert"));
    expect(alert.status).toBe("pending");
  });
  it("monitors SLA and backlog without any contact mutation or automatic response", async () => {
    await db.insert(escalationQueue).values(Array.from({ length: 11 }, (_, i) => ({ contactId: `ticket-contact-${i}`, priority: "normal", reason: "question",
      createdAt: new Date("2026-09-04T05:00:00Z") })));
    const run = await repository.claimWindow("escalation_monitor", "2026-09-07T12", new Date("2026-09-07T02:00:00Z"));
    const result = await executeMonitoringRun(repository, run.run.id, sources, noAlerts, options);
    expect(result).toMatchObject({ processed: 11, queued: 12, sent: 0 });
    expect(await executeMonitoringRun(repository, run.run.id, sources, noAlerts, options)).toEqual(result);
    const alerts = await db.select().from(monitoringAlerts).where(eq(monitoringAlerts.kind, "escalation_monitor"));
    expect(alerts).toHaveLength(12);
    expect(JSON.stringify(alerts)).toContain("SLA breached");
  });
});

