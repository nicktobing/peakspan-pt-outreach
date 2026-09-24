import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { ExecutionRepository } from "@/lib/db/repositories";
import { idempotencyKey, payloadHash } from "@/lib/domain/idempotency";

const client = new PGlite();
const db = drizzle(client);
const repository = new ExecutionRepository(db);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await migrate(db, { migrationsFolder: "./drizzle" });
});
afterAll(async () => { await client.close(); });

describe("Postgres repository concurrency", () => {
  it("gives exactly one caller an action claim and preserves unknown outcomes", async () => {
    const input = { contactId: "c", action: "follow", idempotencyKey: idempotencyKey("follow", "c", "v1") };
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.claimAction(input)));
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    const attemptId = results[0].attempt.id;
    expect(await repository.recordProviderRun(attemptId, "run-1")).not.toBeNull();
    expect(await repository.recordProviderRun(attemptId, "run-2")).toBeNull();
    expect((await repository.finishAction(attemptId, "unknown"))?.status).toBe("paused");
    expect(await repository.finishAction(attemptId, "succeeded")).toBeNull();
    expect((await repository.claimAction(input)).acquired).toBe(false);
    await expect(repository.claimAction({ ...input, contactId: "different" })).rejects.toThrow("identity mismatch");
  });
  it("claims a schedule once across concurrent calls", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => repository.claimSchedule({
      workflow: "report", scheduledWindow: "2026-09-08T10", workflowRunId: `workflow-${i}`,
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("deduplicates events and rejects changed payloads for an existing event ID", async () => {
    const input = { source: "fixture", externalId: "event-1", payload: { fixture: true }, payloadHash: payloadHash("fixture") };
    expect((await repository.receiveEvent(input)).acquired).toBe(true);
    expect((await repository.receiveEvent(input)).acquired).toBe(false);
    await expect(repository.receiveEvent({ ...input, payloadHash: payloadHash("different") })).rejects.toThrow("identity mismatch");
  });
  it("keeps suppression active and preserves its original evidence", async () => {
    expect(await repository.isSuppressed("opted-out-contact")).toBe(false);
    await repository.suppress({ contactId: "opted-out-contact", reason: "opt_out", source: "inbox" });
    const replay = await repository.suppress({ contactId: "opted-out-contact", reason: "temporary", source: "cron" });
    expect(replay.reason).toBe("opt_out");
    expect(await repository.isSuppressed("opted-out-contact")).toBe(true);
  });
  it("deduplicates inbox messages", async () => {
    const input = { providerMessageId: "fixture:message-1", contactId: "c", receivedAt: new Date(), preview: "Fixture" };
    expect(await repository.receiveInboxMessage(input)).not.toBeNull();
    expect(await repository.receiveInboxMessage(input)).toBeNull();
  });
});

it("normalizes the same contact ID when saving and checking suppression", async () => {
  await repository.suppress({ contactId: "  padded-contact  ", reason: "opt_out", source: "inbox" });
  expect(await repository.isSuppressed("padded-contact")).toBe(true);
  expect(await repository.isSuppressed("  padded-contact  ")).toBe(true);
});

