import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { LikeRepository } from "@/lib/db/likes";
import { actionAttempts, settings } from "@/lib/db/schema";
import { beginLike, dispatchLike, observeLike, reconcileLike, type LikeDependencies } from "@/lib/likes/service";
import type { LikeObservation, LikeTarget } from "@/lib/likes/contracts";
import { ProviderError } from "@/lib/clients/errors";
import { createHash } from "node:crypto";

const client = new PGlite(); const db = drizzle(client); const repository = new LikeRepository(db);
const target = (shortcode: string): LikeTarget => ({ accountId: BigInt(`0x${createHash("sha256").update(shortcode).digest("hex").slice(0, 12)}`).toString(), accountUsername: "fixture_account", contactId: "contact", targetUsername: "fixture_target",
  postUrl: `https://www.instagram.com/reel/${shortcode}/` });
function deps(): LikeDependencies {
  return { repository, provider: { start: vi.fn(async () => "fixture-run"), observe: vi.fn(async (): Promise<LikeObservation> => ({ state: "success", costUsd: 0.008 })) },
    canStart: async () => true, canReconcile: async () => true, addSuccessTag: vi.fn(async () => {}) };
}
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });

describe("durable like claims and reconciliation", () => {
  it("dispatches once across concurrent requests and post/reel aliases", async () => {
    const start = vi.fn(async () => "fixture-workflow");
    const values = Array.from({ length: 6 }, (_, i) => ({ ...target("Concurrent"), postUrl: `https://instagram.com/${i % 2 ? "p" : "reel"}/Concurrent/?x=1` }));
    const result = await Promise.all(values.map((value) => dispatchLike(repository, value, start)));
    expect(result.filter((value) => value.status === "accepted")).toHaveLength(1); expect(start).toHaveBeenCalledTimes(1);
    const id = result[0].request.id!;
    expect((await repository.read(id)).data.workflowRunId).toBe("fixture-workflow");
    await expect(repository.claim({ ...target("Concurrent"), contactId: "wrong-contact" })).rejects.toThrow("identity conflict");
  });
  it("does not release an uncertain workflow dispatch", async () => {
    const start = vi.fn(async () => { throw new Error("lost response"); });
    const result = await dispatchLike(repository, target("DispatchUnknown"), start);
    expect(result).toMatchObject({ status: "dispatch_unknown", request: { state: "paused", reason: "dispatch_unknown" } });
    expect((await dispatchLike(repository, target("DispatchUnknown"), start)).status).toBe("duplicate");
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("claims the sending transition once, records provider success, then adds the CRM tag", async () => {
    const { id } = await repository.claim(target("SendOnce")); const dependencies = deps();
    await Promise.all(Array.from({ length: 5 }, () => beginLike(id, dependencies)));
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
    expect((await repository.progress(id)).state).toBe("polling");
    expect(dependencies.addSuccessTag).not.toHaveBeenCalled();
    await observeLike(id, dependencies);
    expect(await repository.progress(id)).toMatchObject({ state: "provider_succeeded", providerStatus: "success", costUsd: "0.008000" });
    await reconcileLike(id, dependencies); await beginLike(id, dependencies); await reconcileLike(id, dependencies);
    expect((await repository.progress(id)).state).toBe("succeeded");
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1); expect(dependencies.addSuccessTag).toHaveBeenCalledTimes(1);
    const [action] = await db.select().from(actionAttempts).where(eq(actionAttempts.id, id));
    expect(action.status).toBe("succeeded"); expect(action.action).toBe("like");
    expect(JSON.stringify(action.result)).not.toContain("cookies");
  });
  it("retries only GHL reconciliation after a provider success", async () => {
    const { id } = await repository.claim(target("CrmRetry")); const dependencies = deps();
    await beginLike(id, dependencies); await observeLike(id, dependencies);
    dependencies.addSuccessTag = vi.fn().mockRejectedValueOnce(new Error("GHL unavailable")).mockResolvedValue(undefined);
    await expect(reconcileLike(id, dependencies)).rejects.toThrow();
    expect((await repository.read(id)).data.phase).toBe("provider_succeeded");
    await repository.pause(id, "execution_failed", ["provider_succeeded"]);
    await reconcileLike(id, dependencies);
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
    expect((await repository.progress(id)).state).toBe("succeeded");
  });
  it("blocks an ineligible or suppressed contact before actor start", async () => {
    const { id } = await repository.claim(target("Suppressed")); const dependencies = deps();
    dependencies.canStart = async () => false;
    expect(await beginLike(id, dependencies)).toMatchObject({ state: "paused", reason: "not_authorized" });
    expect(dependencies.provider.start).not.toHaveBeenCalled();
  });
  it("never repeats a start with an unknown result or after a crash in starting", async () => {
    const { id } = await repository.claim(target("Unknown")); const dependencies = deps();
    dependencies.provider.start = vi.fn(async () => { throw new ProviderError("apify", "unknown_outcome"); });
    await beginLike(id, dependencies); await beginLike(id, dependencies); await observeLike(id, dependencies);
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
    expect(await repository.progress(id)).toMatchObject({ state: "paused", reason: "start_unknown" });
    const crash = await repository.claim(target("Crash")); await repository.beginStart(crash.id);
    await beginLike(crash.id, dependencies);
    expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
    expect((await repository.progress(crash.id)).state).toBe("starting");
  });
  it.each(["auth_error", "blocked", "rate_limited"] as const)("trips the persistent like circuit on %s", async (state) => {
    const { id } = await repository.claim(target(`Circuit_${state}`)); const dependencies = deps();
    await beginLike(id, dependencies);
    dependencies.provider.observe = async () => ({ state });
    expect((await observeLike(id, dependencies)).state).toBe("paused");
    const [setting] = await db.select().from(settings).where(eq(settings.key, "outbound_disabled:like"));
    expect(setting.value).toEqual({ disabled: true, reason: `instagram_like_${state}` });
    expect(dependencies.addSuccessTag).not.toHaveBeenCalled();
  });
  it("trips the circuit for provider authentication failure at start", async () => {
    const { id } = await repository.claim(target("BadSession")); const dependencies = deps();
    dependencies.provider.start = async () => { throw new ProviderError("apify", "authentication"); };
    await beginLike(id, dependencies);
    const [setting] = await db.select().from(settings).where(eq(settings.key, "outbound_disabled:like"));
    expect(setting.value).toEqual({ disabled: true, reason: "instagram_like_authentication" });
  });
  it("can inspect a known provider reference after a timeout without starting again", async () => {
    const { id } = await repository.claim(target("Timeout")); const dependencies = deps();
    await beginLike(id, dependencies); await repository.pause(id, "poll_timeout", ["polling"]);
    await observeLike(id, dependencies); await reconcileLike(id, dependencies);
    expect((await repository.progress(id)).state).toBe("succeeded"); expect(dependencies.provider.start).toHaveBeenCalledTimes(1);
  });
  it("keeps unknown output for reconciliation and honors a kill switch before CRM writes", async () => {
    const { id } = await repository.claim(target("UnknownDataset")); const dependencies = deps();
    await beginLike(id, dependencies); dependencies.provider.observe = async () => ({ state: "unknown" });
    expect(await observeLike(id, dependencies)).toMatchObject({ state: "paused", reason: "provider_unknown" });
    expect(dependencies.addSuccessTag).not.toHaveBeenCalled();
    dependencies.provider.observe = async () => ({ state: "success" }); await observeLike(id, dependencies);
    dependencies.canReconcile = async () => false;
    expect(await reconcileLike(id, dependencies)).toMatchObject({ state: "paused", reason: "reconciliation_disabled" });
    expect(dependencies.addSuccessTag).not.toHaveBeenCalled();
  });
});

