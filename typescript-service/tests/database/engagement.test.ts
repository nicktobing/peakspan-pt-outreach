import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { EngagementRepository } from "@/lib/db/engagement";
import { DmApprovalRepository } from "@/lib/db/dm-approvals";
import { beginEngagement, observeEngagement, reconcileEngagement, type EngagementDependencies } from "@/lib/engagement/service";
import { executeEngagementStageWithDependencies } from "@/lib/engagement/runtime";
import type { EngagementObservation, EngagementTarget } from "@/lib/engagement/contracts";
import { workflowRuns } from "@/lib/db/schema";

const client = new PGlite(); const db = drizzle(client); const repository = new EngagementRepository(db);
const follow = (accountId: string): EngagementTarget => ({ action: "follow", accountId, accountUsername: "acting", contactId: `contact-${accountId}`, targetUsername: `target_${accountId}` });
function deps(): EngagementDependencies { return { repository, provider: { start: vi.fn(async () => "provider-run"),
  observe: vi.fn(async (): Promise<EngagementObservation> => ({ state: "success", costUsd: 0.01 })) },
  canStart: async () => true, canReconcile: async () => true, addSuccessTag: vi.fn(async () => {}) }; }
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });

describe("durable engagement stages", () => {
  it("claims a contact stage once and never starts it twice", async () => {
    const target = follow("701"); const results = await Promise.all(Array.from({ length: 5 }, () => repository.claim(target)));
    expect(results.filter((row) => row.acquired)).toHaveLength(1);
    const dependencies = deps(); const id = results[0].id;
    await Promise.all(Array.from({ length: 5 }, () => beginEngagement(id, dependencies)));
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
    await observeEngagement(id, dependencies); expect((await repository.progress(id)).state).toBe("provider_succeeded");
    await reconcileEngagement(id, dependencies); expect((await repository.progress(id)).state).toBe("succeeded");
    expect(dependencies.addSuccessTag).toHaveBeenCalledTimes(1);
  });
  it("holds an unknown provider result and does not reconcile a CRM tag", async () => {
    const claim = await repository.claim(follow("702")); const dependencies = deps();
    await beginEngagement(claim.id, dependencies); dependencies.provider.observe = async () => ({ state: "unknown" });
    expect(await observeEngagement(claim.id, dependencies)).toMatchObject({ state: "paused", reason: "provider_unknown" });
    expect(dependencies.addSuccessTag).not.toHaveBeenCalled();
    await beginEngagement(claim.id, dependencies); expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
  });
  it("settles a definitive provider failure without retrying and releases the unresolved-action lock", async () => {
    const target = follow("713"); const claim = await repository.claim(target); const dependencies = deps();
    await beginEngagement(claim.id, dependencies); dependencies.provider.observe = async () => ({ state: "failed", costUsd: 0.00032 });
    expect(await observeEngagement(claim.id, dependencies)).toMatchObject({ state: "cancelled", reason: "provider_failed", costUsd: "0.000320" });
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1); expect(dependencies.addSuccessTag).not.toHaveBeenCalled();
    await expect(repository.claim({ ...target, contactId: "contact-713-next", targetUsername: "target_713_next" }))
      .resolves.toMatchObject({ acquired: true });
  });
  it("observes an existing paused run while launch flags are closed and never starts it again", async () => {
    const target = follow("714"); const claim = await repository.claim(target); const dependencies = deps();
    await beginEngagement(claim.id, dependencies); dependencies.provider.observe = async () => ({ state: "unknown" });
    await observeEngagement(claim.id, dependencies);
    vi.stubEnv("IG_FOLLOW_ENABLED", "false"); vi.stubEnv("IG_COMMENT_ENABLED", "false"); vi.stubEnv("IG_DM_ENABLED", "false");
    dependencies.provider.observe = async () => ({ state: "failed" });
    expect(await executeEngagementStageWithDependencies(claim.id, "observe", dependencies))
      .toMatchObject({ state: "cancelled", reason: "provider_failed" });
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
  it.each(["requested", "already_following"] as const)("retains the exact %s provider outcome before reconciliation", async (state) => {
    const target = follow(state === "requested" ? "705" : "706"); const claim = await repository.claim(target); const dependencies = deps();
    await beginEngagement(claim.id, dependencies); dependencies.provider.observe = async () => ({ state });
    expect(await observeEngagement(claim.id, dependencies)).toMatchObject({ state: "provider_succeeded", providerOutcome: state });
    await reconcileEngagement(claim.id, dependencies);
    expect(await repository.progress(claim.id)).toMatchObject({ state: "succeeded", providerOutcome: state });
    expect(dependencies.addSuccessTag).toHaveBeenCalledTimes(state === "requested" ? 0 : 1);
  });
  it("fails closed when a legacy successful follow has no exact provider outcome", async () => {
    const target = follow("715"); const claim = await repository.claim(target); const dependencies = deps();
    await beginEngagement(claim.id, dependencies); await repository.providerSuccess(claim.id, 0.01);
    expect(await reconcileEngagement(claim.id, dependencies)).toMatchObject({ state: "paused", reason: "provider_unknown" });
    expect(dependencies.addSuccessTag).not.toHaveBeenCalled();
  });
  it.each(["success", "requested", "already_following"] as const)(
    "finishes an observed %s follow while launch flags stay closed without restarting the provider", async (state) => {
      const accountId = state === "success" ? "716" : state === "requested" ? "717" : "718";
      const target = follow(accountId); const claim = await repository.claim(target); const dependencies = deps();
      await beginEngagement(claim.id, dependencies);
      vi.stubEnv("IG_FOLLOW_ENABLED", "false"); vi.stubEnv("IG_COMMENT_ENABLED", "false"); vi.stubEnv("IG_DM_ENABLED", "false");
      dependencies.provider.observe = async () => ({ state });
      await executeEngagementStageWithDependencies(claim.id, "observe", dependencies);
      expect(await executeEngagementStageWithDependencies(claim.id, "reconcile", dependencies))
        .toMatchObject({ state: "succeeded", providerOutcome: state === "success" ? "followed" : state });
      expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
      expect(dependencies.addSuccessTag).toHaveBeenCalledTimes(state === "requested" ? 0 : 1);
      vi.unstubAllEnvs();
    },
  );
  it("only cancels an exact paused unknown provider run and releases the account lock", async () => {
    const target = follow("704"); const claim = await repository.claim(target); const dependencies = deps();
    await beginEngagement(claim.id, dependencies); dependencies.provider.observe = async () => ({ state: "unknown" });
    await observeEngagement(claim.id, dependencies);
    await expect(repository.cancelPausedUnknown(claim.id, "wrong-run")).rejects.toThrow("does not match");
    expect(await repository.cancelPausedUnknown(claim.id, "provider-run")).toMatchObject({ state: "cancelled", reason: "operator_cancelled" });
    const next = { ...target, contactId: "contact-704-next", targetUsername: "target_704_next" };
    await expect(repository.claim(next)).resolves.toMatchObject({ acquired: true });
  });
  it("does not overlap an account owned by an unfinished like batch", async () => {
    await db.insert(workflowRuns).values({ workflow: "instagram_like_batch", workflowRunId: "active-like-batch",
      status: "running", result: { accountId: "703" } });
    await expect(repository.claim(follow("703"))).rejects.toThrow("like session is active");
  });
});

describe("immutable DM approval", () => {
  it("requires an approved exact snapshot item", async () => {
    const approvals = new DmApprovalRepository(db); const text = "Hi, PeakSpan has an affiliate referral opportunity.";
    const row = await approvals.create({ version: 1, accountId: "800", accountUsername: "acting",
      items: [{ contactId: "contact-800", targetUsername: "target_800", text }] });
    expect(await approvals.allows(row.id, { contactId: "contact-800", targetUsername: "target_800", text }, "800", "acting")).toBe(false);
    await approvals.decide(row.id, "approved", "reviewer");
    expect(await approvals.allows(row.id, { contactId: "contact-800", targetUsername: "target_800", text }, "800", "acting")).toBe(true);
    expect(await approvals.allows(row.id, { contactId: "contact-800", targetUsername: "target_800", text: `${text} changed` }, "800", "acting")).toBe(false);
    await expect(approvals.decide(row.id, "rejected", "other")).rejects.toThrow("not pending");
  });
  it("rejects multiple approved drafts for one contact", async () => {
    const approvals = new DmApprovalRepository(db);
    await expect(approvals.create({ version: 1, accountId: "801", accountUsername: "acting", items: [
      { contactId: "same-contact", targetUsername: "first_target", text: "Hi, PeakSpan has an affiliate referral opportunity." },
      { contactId: "same-contact", targetUsername: "second_target", text: "PeakSpan would like to discuss a referral affiliate opportunity." },
    ] })).rejects.toThrow("Duplicate contact");
  });
});
