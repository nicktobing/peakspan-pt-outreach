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
    expect(await repository.beginContact(plan.id, "contact-0")).toBe(true);
    expect(await repository.beginContact(plan.id, "contact-0")).toBe(false);
    expect(await repository.canCreate(plan.id, "contact-0")).toBe(true);
    expect(await repository.canCreate(plan.id, "contact-1")).toBe(false);
    await repository.record(plan.id, { contactId: "contact-0", opportunityId: "opp-0", evidence: "response" });
    expect(await repository.canCreate(plan.id, "contact-0")).toBe(false);
    expect((await repository.progress(plan.id)).outcomes).toEqual([
      { contactId: "contact-0", opportunityId: "opp-0", evidence: "response" },
    ]);
  });
});
