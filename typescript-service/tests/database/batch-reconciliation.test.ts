import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { randomUUID } from "node:crypto";
import { LikeBatchRepository } from "@/lib/db/like-batches";
import { LikeRepository } from "@/lib/db/likes";
import { batchConfigSchema, type BatchState } from "@/lib/likes/batch-contracts";
import { canStartLike, executeLikeStage, likeReconciliationAllowed } from "@/lib/likes/runtime";
const mocks = vi.hoisted(() => ({ tags: vi.fn(), start: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/db/settings", () => ({ getActionSwitch: async () => ({ disabled: false }) }));
vi.mock("@/lib/clients/ghl", () => ({ GhlClient: class {
  constructor(_token: string, _location: string, private options: { authorizeWrite?: () => Promise<boolean> }) {}
  async getContact() { return { id: "contact", tags: ["qualified", "ig-followed"] }; }
  async addTags(...args: unknown[]) { if (!await this.options.authorizeWrite?.()) throw new Error("denied"); mocks.tags(...args); }
} }));
vi.mock("@/lib/clients/apify", () => ({ ApifyClient: class { startActor = mocks.start; } }));
const client = new PGlite(); const db = drizzle(client);
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });
afterEach(() => vi.unstubAllEnvs());
it("reconciles a completed provider action after cancellation without allowing another send", async () => {
  const target = { accountId: "710", accountUsername: "account", contactId: "contact", targetUsername: "trainer", postUrl: "https://www.instagram.com/reel/CancelTest/" };
  for (const [key, value] of Object.entries({ VERCEL_ENV: "production", IG_LIKE_ENABLED: "true", IG_BATCH_ENABLED: "true",
    OUTREACH_EMERGENCY_DISABLED: "false", IG_LIKE_ACCOUNT_ID: target.accountId, IG_LIKE_ACCOUNT_USERNAME: target.accountUsername,
    GHL_API_TOKEN: "fixture", GHL_LOCATION_ID: "fixture", APIFY_API_TOKEN: "fixture" })) vi.stubEnv(key, value);
  const state: BatchState = { version: 1, accountId: target.accountId, accountUsername: target.accountUsername, mode: "execute",
    profileFieldId: "profile", cursor: 0, nextAt: new Date().toISOString(), limits: batchConfigSchema.parse({}),
    items: [{ contactId: target.contactId, username: target.targetUsername, phase: "ready", polls: 0, postUrl: target.postUrl }] };
  const batches = new LikeBatchRepository(db); const likes = new LikeRepository(db);
  const { id } = await batches.create(randomUUID(), state); const claim = await likes.claim(target, { sessionId: id });
  await batches.change(id, (s) => { s.items[0].actionId = claim.id; s.items[0].phase = "like_active"; });
  await likes.beginStart(claim.id); await likes.recordStart(claim.id, "known-run"); await batches.cancel(id);
  expect(await canStartLike(target, id)).toBe(false);
  expect(await likeReconciliationAllowed(target, claim.id, id)).toBe(false);
  await likes.providerSuccess(claim.id);
  expect(await likeReconciliationAllowed({ ...target, contactId: "wrong" }, claim.id, id)).toBe(false);
  vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "true");
  expect(await likeReconciliationAllowed(target, claim.id, id)).toBe(false);
  vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "false");
  expect(await executeLikeStage(claim.id, "reconcile")).toMatchObject({ state: "succeeded" });
  expect(mocks.tags).toHaveBeenCalledWith("contact", ["ig-liked"]); expect(mocks.start).not.toHaveBeenCalled();
  expect((await likes.claim({ ...target, postUrl: "https://www.instagram.com/reel/NextTest/" })).acquired).toBe(true);
});

