import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { randomUUID } from "node:crypto";
import { LikeBatchRepository } from "@/lib/db/like-batches";
import { LikeRepository } from "@/lib/db/likes";
import { settings } from "@/lib/db/schema";
import { batchConfigSchema, type BatchState } from "@/lib/likes/batch-contracts";
import { prepareBatch, tickBatch } from "@/lib/likes/batch-runtime";
const mocks = vi.hoisted(() => ({ start: vi.fn(), getRun: vi.fn(), rows: vi.fn(), contact: vi.fn(), contacts: vi.fn(), fields: vi.fn(), like: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/clients/ghl", () => ({ GhlClient: class { getContact = mocks.contact; listContacts = mocks.contacts; listCustomFields = mocks.fields; } }));
vi.mock("@/lib/clients/apify", () => ({ ApifyClient: class { startActor = mocks.start; getRun = mocks.getRun; readDatasetHead = mocks.rows; } }));
vi.mock("@/lib/likes/runtime", () => ({ executeLikeStage: mocks.like }));
const client = new PGlite(); const db = drizzle(client); const batches = new LikeBatchRepository(db);
let serial = 600;
const state = (): BatchState => ({ version: 1, accountId: String(serial++), accountUsername: "account", mode: "preview",
  profileFieldId: "profile", cursor: 0, nextAt: new Date().toISOString(), limits: batchConfigSchema.parse({}),
  items: [{ contactId: "contact", username: "trainer", phase: "queued", polls: 0 }] });
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("IG_BATCH_DISCOVERY_ENABLED", "true");
  vi.stubEnv("IG_BATCH_ENABLED", "false"); vi.stubEnv("IG_LIKE_ENABLED", "false"); vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "true");
  const contact = { id: "contact", tags: ["qualified", "ig-followed"], customFields: [{ id: "profile", value: "https://instagram.com/trainer/" }] };
  mocks.contact.mockResolvedValue(contact); mocks.contacts.mockResolvedValue([contact]);
  mocks.fields.mockResolvedValue([{ id: "profile", fieldKey: "contact.profile_url" }]);
  mocks.start.mockResolvedValue({ id: "scrape-run" }); mocks.getRun.mockResolvedValue({ id: "scrape-run", status: "SUCCEEDED", defaultDatasetId: "dataset" });
  mocks.rows.mockResolvedValue([{ url: "https://instagram.com/reel/Selected/", ownerUsername: "trainer", timestamp: new Date().toISOString() }]);
});
afterEach(() => vi.unstubAllEnvs());
describe("batch execution boundaries", () => {
  it("previews automatic post selection and finishes without starting a like", async () => {
    const s = state(); const { id } = await batches.create(randomUUID(), s);
    for (let i = 0; i < 5; i++) await tickBatch(id);
    const row = await batches.read(id);
    expect(row.status).toBe("succeeded"); expect(row.state.items[0]).toMatchObject({ phase: "succeeded", reason: "preview_only", postUrl: "https://www.instagram.com/reel/Selected/" });
    expect(mocks.start).toHaveBeenCalledTimes(1); expect(mocks.like).not.toHaveBeenCalled();
  });
  it("records the scraper wait so replay resumes polling rather than starting another run", async () => {
    const { id } = await batches.create(randomUUID(), state()); await tickBatch(id);
    mocks.getRun.mockResolvedValueOnce({ id: "scrape-run", status: "RUNNING" });
    const result = await tickBatch(id); expect(result.state).toBe("waiting");
    expect((await batches.read(id)).state.items[0].scrapeRunId).toBe("scrape-run");
    expect((await tickBatch(id)).state).toBe("waiting");
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it("pauses an uncertain scraper start and never repeats it", async () => {
    const { id } = await batches.create(randomUUID(), state()); mocks.start.mockRejectedValue(new Error("lost response"));
    expect(await tickBatch(id)).toEqual({ state: "paused" });
    expect(await tickBatch(id)).toEqual({ state: "paused" }); expect(mocks.start).toHaveBeenCalledTimes(1);
    expect((await batches.read(id)).state.reason).toBe("scrape_start_unknown");
  });
  it.each(["pause", "cancel"])("retains an in-flight scraper reference after concurrent %s", async (operation) => {
    let resolveStart!: (value: { id: string }) => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    mocks.start.mockImplementation(() => { entered(); return new Promise<{ id: string }>((resolve) => { resolveStart = resolve; }); });
    const { id } = await batches.create(randomUUID(), state()); const first = tickBatch(id);
    await started;
    if (operation === "pause") expect(await tickBatch(id)).toEqual({ state: "paused" });
    else await batches.cancel(id);
    resolveStart({ id: "late-known-run" }); await first;
    expect(await batches.read(id)).toMatchObject({ status: operation === "pause" ? "paused" : "cancelled",
      state: { items: [{ phase: "scrape_polling", scrapeRunId: "late-known-run" }] } });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    if (operation === "pause") {
      expect(await batches.resume(id)).toBe(true);
      mocks.getRun.mockResolvedValue({ id: "late-known-run", status: "SUCCEEDED", defaultDatasetId: "dataset" });
      await tickBatch(id); expect(mocks.getRun).toHaveBeenCalledWith("late-known-run");
      expect(mocks.start).toHaveBeenCalledTimes(1);
    }
  });
  it("does not count malformed provider results as a no-post attempt", async () => {
    const s = state(); const { id } = await batches.create(randomUUID(), s); await tickBatch(id);
    mocks.rows.mockResolvedValue([{ error: "private-profile-or-provider-error" }]);
    expect(await tickBatch(id)).toEqual({ state: "paused" }); expect(await batches.noPostCount(s.accountId, "contact")).toBe(0);
  });
  it("ignores a malformed row when the dataset also contains a valid owned post", async () => {
    const s = state(); const { id } = await batches.create(randomUUID(), s); await batches.change(id, (value) => {
      value.items[0].phase = "scrape_polling"; value.items[0].scrapeRunId = "scrape-run";
    });
    mocks.rows.mockResolvedValue([{ error: "unrelated-row" }, {
      url: "https://www.instagram.com/reel/ValidOwned/", ownerUsername: "trainer", timestamp: new Date().toISOString(),
      coauthorProducers: null,
    }]);
    expect(await tickBatch(id)).toEqual({ state: "running" });
    const row = await batches.read(id);
    expect(row.state.items[0]).toMatchObject({ phase: "ready", postUrl: "https://www.instagram.com/reel/ValidOwned/" });
  });
  it("a preview with no posts never changes production no-post counters", async () => {
    const s = state(); const { id } = await batches.create(randomUUID(), s); await tickBatch(id); mocks.rows.mockResolvedValue([]);
    await tickBatch(id); expect(await batches.noPostCount(s.accountId, "contact")).toBe(0);
  });
  it("rechecks a newly suppressed or replied contact before scraping", async () => {
    const { id } = await batches.create(randomUUID(), state());
    mocks.contact.mockResolvedValue({ id: "contact", tags: ["qualified", "ig-followed", "responded"], customFields: [] });
    await tickBatch(id); expect((await batches.read(id)).state.items[0]).toMatchObject({ phase: "skipped", reason: "eligibility_changed" });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("refuses execute mode while gates are disabled before discovery", async () => {
    await expect(prepareBatch(randomUUID(), "execute")).rejects.toThrow("disabled"); expect(mocks.contacts).not.toHaveBeenCalled();
  });
  it("cannot silently skip an atomically reserved action when eligibility changes before the next tick", async () => {
    vi.stubEnv("IG_BATCH_ENABLED", "true"); vi.stubEnv("IG_LIKE_ENABLED", "true"); vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "false");
    await db.insert(settings).values({ key: "outbound_disabled:like", value: { disabled: false }, updatedBy: "fixture" });
    const s = state(); s.mode = "execute"; s.items[0].phase = "ready"; s.items[0].postUrl = "https://www.instagram.com/reel/Atomic/";
    const { id } = await batches.create(randomUUID(), s);
    const claim = await new LikeRepository(db).claim({ accountId: s.accountId, accountUsername: s.accountUsername, contactId: "contact", targetUsername: "trainer", postUrl: s.items[0].postUrl }, { sessionId: id });
    // Simulate worker loss immediately after claim returns. Eligibility changes before replay.
    mocks.contact.mockResolvedValue({ id: "contact", tags: ["responded"], customFields: [] });
    mocks.like.mockResolvedValue({ state: "paused", reason: "not_authorized" });
    expect(await tickBatch(id)).toEqual({ state: "paused" });
    expect(mocks.like).toHaveBeenCalledWith(claim.id, "start");
    expect((await batches.read(id)).state.items[0]).toMatchObject({ actionId: claim.id, phase: "like_active" });
    await batches.cancel(id);
    expect(await new LikeRepository(db).progress(claim.id)).toMatchObject({ state: "cancelled" });
  });
  it("skips a collaboration post previously claimed for another contact and continues the session", async () => {
    vi.stubEnv("IG_BATCH_ENABLED", "true"); vi.stubEnv("IG_LIKE_ENABLED", "true"); vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "false");
    await db.insert(settings).values({ key: "outbound_disabled:like", value: { disabled: false }, updatedBy: "fixture" }).onConflictDoNothing();
    const s = state(); s.mode = "execute"; s.items[0].phase = "ready"; s.items[0].postUrl = "https://www.instagram.com/reel/SharedCollab/";
    s.items.push({ contactId: "next", username: "next_trainer", phase: "queued", polls: 0 });
    const likes = new LikeRepository(db);
    const prior = await likes.claim({ accountId: s.accountId, accountUsername: s.accountUsername, contactId: "previous", targetUsername: "other_coauthor", postUrl: s.items[0].postUrl });
    await likes.beginStart(prior.id); await likes.recordStart(prior.id, "prior-run"); await likes.providerSuccess(prior.id); await likes.complete(prior.id);
    const { id } = await batches.create(randomUUID(), s);
    expect(await tickBatch(id)).toEqual({ state: "running" });
    expect((await batches.read(id)).state.items[0]).toMatchObject({ phase: "skipped", reason: "post_already_reserved" });
    expect((await batches.read(id)).state.items[0].actionId).toBeUndefined(); expect(mocks.like).not.toHaveBeenCalled();
    await tickBatch(id); expect((await batches.read(id)).state.cursor).toBe(1);
    await batches.change(id, (data) => { data.nextAt = new Date().toISOString(); });
    mocks.contact.mockResolvedValue({ id: "next", tags: ["qualified", "ig-followed"], customFields: [{ id: "profile", value: "next_trainer" }] });
    await tickBatch(id); expect(mocks.start).toHaveBeenCalledTimes(1);
    expect((await likes.read(prior.id)).status).toBe("succeeded");
  });
});

