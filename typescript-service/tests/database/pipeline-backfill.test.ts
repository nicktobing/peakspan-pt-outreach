import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PipelineBackfillRepository } from "@/lib/db/pipeline-backfill";
import { createPipelinePlan } from "@/lib/pipeline/backfill-contracts";

const client = new PGlite(); const db = drizzle(client); const repository = new PipelineBackfillRepository(db);
const plan = createPipelinePlan({ version: 1, pipelineId: "pipeline", locationId: "location",
  items: Array.from({ length: 10 }, (_, index) => ({ contactId: `contact-${index}`, username: `trainer_${index}`,
    opportunityName: `PT Affiliate - @trainer_${index}`, stageId: "qualified", stageName: "Qualified" })) });
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });

describe("durable pipeline backfill ledger", () => {
  it("grants exactly one plan claim under concurrent requests", async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => repository.claim(plan)));
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
    expect(claims.every((claim) => claim.progress.plan.id === plan.id)).toBe(true);
  });
  it("allows only the claimed current contact and persists each outcome", async () => {
    const leaseId = (await repository.progress(plan.id)).leaseId;
    expect(await repository.beginContact(plan.id, "contact-0", leaseId)).toBe(true);
    expect(await repository.beginContact(plan.id, "contact-0", leaseId)).toBe(false);
    expect(await repository.canCreate(plan.id, "contact-0", leaseId)).toBe(false);
    expect(await repository.markWriteAttempted(plan.id, "contact-0", leaseId)).toBe(true);
    expect(await repository.canCreate(plan.id, "contact-0", leaseId)).toBe(true);
    expect(await repository.canCreate(plan.id, "contact-1", leaseId)).toBe(false);
    expect(await repository.consumeCreateAuthorization(plan.id, "contact-0", leaseId)).toBe(true);
    expect(await repository.consumeCreateAuthorization(plan.id, "contact-0", leaseId)).toBe(false);
    expect(await repository.canCreate(plan.id, "contact-0", leaseId)).toBe(false);
    await repository.record(plan.id, { contactId: "contact-0", opportunityId: "opp-0", evidence: "response" }, leaseId);
    expect(await repository.canCreate(plan.id, "contact-0", leaseId)).toBe(false);
    expect((await repository.progress(plan.id)).outcomes).toEqual([
      { contactId: "contact-0", opportunityId: "opp-0", evidence: "response" },
    ]);
  });
  it("fences the previous lease and records a reconciled uncertain contact after resume", async () => {
    const oldLease = (await repository.progress(plan.id)).leaseId;
    expect(await repository.beginContact(plan.id, "contact-1", oldLease)).toBe(true);
    expect(await repository.markWriteAttempted(plan.id, "contact-1", oldLease)).toBe(true);
    await repository.stop(plan.id, "contact-1", "provider_unknown", oldLease);
    const resumed = await repository.resume(plan.id, new Date()); expect(resumed.acquired).toBe(true);
    const newLease = resumed.progress.leaseId; expect(newLease).not.toBe(oldLease);
    expect(await repository.canCreate(plan.id, "contact-1", oldLease)).toBe(false);
    await expect(repository.stop(plan.id, "contact-1", "provider_unknown", oldLease)).rejects.toThrow("lost its lease");
    await expect(repository.record(plan.id, { contactId: "contact-1", opportunityId: "stale", evidence: "reconciled" }, oldLease))
      .rejects.toThrow("could not be recorded");
    await repository.record(plan.id, { contactId: "contact-1", opportunityId: "opp-1", evidence: "reconciled" }, newLease);
    expect((await repository.progress(plan.id)).outcomes.at(-1)).toEqual(
      { contactId: "contact-1", opportunityId: "opp-1", evidence: "reconciled" });
  });
});
