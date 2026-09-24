import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { actionAttempts, monitoringAlerts } from "@/lib/db/schema";
import { AdmissionRepository, admissionInput, DIRECTORY_TAG } from "@/lib/leads/admissions";
import { importDirectoryLead, directoryContactAllowed, reconcileDirectoryImport, retryRejectedDirectoryImport } from "@/lib/leads/runtime";
import { FailureAlertRepository } from "@/lib/likes/failure-alerts";
import { batchEligible } from "@/lib/likes/batch-contracts";
const mocks = vi.hoisted(() => ({ list: vi.fn(), fields: vi.fn(), create: vi.fn(), note: vi.fn(), tags: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/clients/ghl", () => ({ GhlClient: class { listContacts = mocks.list; listCustomFields = mocks.fields; createDirectoryContact = mocks.create; addNote = mocks.note; addTags = mocks.tags; getContact = mocks.get; } }));
const client = new PGlite(); const db = drizzle(client); const repo = new AdmissionRepository(db);
const input = (username = "new_trainer") => admissionInput.parse({ lead: { business_name: "New Trainer", instagram_url: username, public_email: "trainer@example.test" },
  qualification: { australianPtBusiness: true, officialInstagramLinked: true, rationale: "Official Australian personal training business website links this profile.", evidenceUrls: ["https://example.test"], checkedAt: new Date().toISOString() } });
const contact = { id: "new-contact", email: "trainer@example.test", tags: [DIRECTORY_TAG], customFields: [] };
beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await db.delete(actionAttempts); await db.delete(monitoringAlerts); vi.resetAllMocks();
  vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("DIRECTORY_LAUNCH_ENABLED", "true"); vi.stubEnv("GHL_LOCATION_ID", "location");
  mocks.fields.mockResolvedValue([]); mocks.list.mockResolvedValue([contact]); mocks.create.mockResolvedValue(contact); mocks.note.mockResolvedValue({}); mocks.tags.mockResolvedValue({});
  mocks.get.mockResolvedValue(contact);
});
afterEach(() => vi.unstubAllEnvs());
it("claims one import across concurrent callers and serializes even different identities", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => repo.claim("location", input())));
  expect(results.filter((r) => r.acquired)).toHaveLength(1);
  await expect(repo.claim("location", input("other_trainer"))).rejects.toThrow("attention");
});
it("skips every existing GHL match without create, note, or tag writes", async () => {
  const result = await importDirectoryLead(input()); expect(result.data.phase).toBe("duplicate");
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.note).not.toHaveBeenCalled(); expect(mocks.tags).not.toHaveBeenCalled();
});
it("imports once, records evidence, and only uses a dedicated like-stage qualification tag", async () => {
  mocks.list.mockResolvedValueOnce([]).mockResolvedValue([contact]);
  const result = await importDirectoryLead(input()); expect(result.status).toBe("succeeded");
  expect(result.data).toMatchObject({ phase: "complete", contactId: contact.id });
  expect(mocks.tags).toHaveBeenCalledWith(contact.id, [DIRECTORY_TAG]);
  expect((await importDirectoryLead(input())).id).toBe(result.id); expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(await directoryContactAllowed(contact.id, "new_trainer")).toBe(true);
  mocks.list.mockResolvedValue([contact, { ...contact, id: "older-contact" }]);
  expect(await directoryContactAllowed(contact.id, "new_trainer")).toBe(false);
});
it("preserves an unknown creation, refuses blind replay, blocks following imports, and queues an alert", async () => {
  mocks.list.mockResolvedValue([]); mocks.create.mockRejectedValue(new Error("unknown provider response"));
  const result = await importDirectoryLead(input()); expect(result.status).toBe("paused");
  await importDirectoryLead(input()); expect(mocks.create).toHaveBeenCalledTimes(1);
  await expect(importDirectoryLead(input("another"))).rejects.toThrow("attention");
  expect(await new FailureAlertRepository(db).collect()).toBe(0);
  const alerts = await db.select().from(monitoringAlerts); expect(alerts).toHaveLength(1); expect(JSON.stringify(alerts)).not.toContain("unknown provider response");
});
it("holds a concurrent external duplicate after creation before qualification or notes", async () => {
  mocks.list.mockResolvedValueOnce([]).mockResolvedValue([contact, { ...contact, id: "concurrent" }]);
  const result = await importDirectoryLead(input()); expect(result.status).toBe("paused");
  expect(result.data.contactId).toBe(contact.id); expect(mocks.tags).not.toHaveBeenCalled(); expect(mocks.note).not.toHaveBeenCalled();
});
it("includes alternate duplicate-row identities in the live check", async () => {
  const data = input(); data.variants = [{ ...data.lead, public_email: "known@example.test" }];
  mocks.list.mockResolvedValue([{ ...contact, email: "known@example.test" }]);
  expect((await importDirectoryLead(data)).data.phase).toBe("duplicate"); expect(mocks.create).not.toHaveBeenCalled();
});
it("does not admit a tagged existing contact without a completed import record", async () => {
  expect(await directoryContactAllowed(contact.id, "new_trainer")).toBe(false); expect(mocks.list).not.toHaveBeenCalled();
  expect(batchEligible(contact)).toBe(false); expect(batchEligible(contact, false, "directory")).toBe(true);
  expect(batchEligible({ ...contact, tags: [DIRECTORY_TAG, "responded"] }, false, "directory")).toBe(false);
});
it("alerts on worker loss after an import claim without automatically releasing or restarting it", async () => {
  const claimed = await repo.claim("location", input());
  await db.update(actionAttempts).set({ updatedAt: new Date(Date.now() - 16 * 60000) });
  expect(await new FailureAlertRepository(db).collect()).toBe(1); expect(await new FailureAlertRepository(db).collect()).toBe(0);
  expect((await repo.claim("location", input())).acquired).toBe(false); expect((await repo.read(claimed.id)).status).toBe("running");
});
it("requires a live gate and recent verified qualification before touching GHL", async () => {
  const data = input(); data.qualification.checkedAt = "2020-01-01T00:00:00.000Z";
  await expect(importDirectoryLead(data)).rejects.toThrow("refresh");
  vi.stubEnv("DIRECTORY_LAUNCH_ENABLED", "false"); await expect(importDirectoryLead(input())).rejects.toThrow("disabled");
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
it("retries a settled permanent rejection once under the same claim and accepts an Instagram-only contact", async () => {
  const data = input(); data.lead.public_email = ""; data.lead.email_address = ""; data.lead.public_phone = "";
  mocks.list.mockResolvedValue([]); mocks.create.mockRejectedValueOnce(new (await import("@/lib/clients/errors")).ProviderError("ghl", "permanent", 400));
  const row = await importDirectoryLead(data); expect(row.data).toMatchObject({ phase: "paused", pausedFrom: "creating", failureCode: "ghl_permanent_400" });
  await db.update(actionAttempts).set({ updatedAt: new Date(Date.now() - 61000) });
  mocks.create.mockResolvedValue(contact); mocks.list.mockResolvedValueOnce([]).mockResolvedValue([contact]);
  const retried = await retryRejectedDirectoryImport(row.id);
  expect(retried).toMatchObject({ status: "succeeded", data: { phase: "complete", retryCount: 1, contactId: contact.id } });
  expect(mocks.create).toHaveBeenCalledTimes(2); expect(mocks.note).toHaveBeenCalledTimes(1); expect(mocks.tags).toHaveBeenCalledTimes(1);
  await expect(retryRejectedDirectoryImport(row.id)).rejects.toThrow("not retryable");
});
it("uses the Instagram identity as the CRM name when the business name is empty", async () => {
  const data = input(); data.lead.business_name = ""; data.lead.public_email = ""; data.lead.email_address = ""; data.lead.public_phone = "";
  mocks.list.mockResolvedValueOnce([]).mockResolvedValue([contact]);
  const row = await importDirectoryLead(data); expect(row.status).toBe("succeeded");
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: "@new_trainer", companyName: "@new_trainer" }));
});
it("queues new saved-contact guidance when a retry later pauses after returning an ID", async () => {
  mocks.list.mockResolvedValue([]); mocks.create.mockRejectedValueOnce(new (await import("@/lib/clients/errors")).ProviderError("ghl", "permanent", 400));
  const row = await importDirectoryLead(input()); await db.update(actionAttempts).set({ updatedAt: new Date(Date.now() - 61000) });
  mocks.create.mockResolvedValue(contact); mocks.list.mockResolvedValueOnce([]).mockResolvedValue([contact]); mocks.note.mockRejectedValue(new Error("unknown note result"));
  expect((await retryRejectedDirectoryImport(row.id)).status).toBe("paused");
  const alerts = await db.select().from(monitoringAlerts); expect(alerts).toHaveLength(2);
  const payloads = alerts.map((alert) => JSON.stringify(alert.payload));
  expect(payloads.some((payload) => payload.includes("No contact ID was returned"))).toBe(true);
  expect(payloads.some((payload) => payload.includes("Inspect the saved contact reference"))).toBe(true);
});
it("refuses to retry a rejected create when a matching contact appears", async () => {
  mocks.list.mockResolvedValue([]); mocks.create.mockRejectedValue(new (await import("@/lib/clients/errors")).ProviderError("ghl", "permanent", 400));
  const row = await importDirectoryLead(input()); await db.update(actionAttempts).set({ updatedAt: new Date(Date.now() - 61000) });
  mocks.list.mockResolvedValue([contact]);
  await expect(retryRejectedDirectoryImport(row.id)).rejects.toThrow("matching GHL contact");
  expect((await repo.read(row.id)).status).toBe("paused");
});
it("reconciles only the known new contact without repeating create or an uncertain note", async () => {
  mocks.list.mockResolvedValueOnce([]).mockResolvedValue([contact]); mocks.note.mockRejectedValue(new Error("note response unknown"));
  const row = await importDirectoryLead(input()); expect(row.data.pausedFrom).toBe("noting"); expect(row.data.createdNew).toBe(true);
  await db.update(actionAttempts).set({ updatedAt: new Date(Date.now() - 61000) });
  const results = await Promise.all([reconcileDirectoryImport(row.id), reconcileDirectoryImport(row.id)]);
  expect(results.some((r) => r.status === "succeeded")).toBe(true);
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.note).toHaveBeenCalledTimes(1); expect(mocks.tags).toHaveBeenCalledTimes(1);
  await reconcileDirectoryImport(row.id); expect(mocks.tags).toHaveBeenCalledTimes(1);
});
it("does not use reconciliation to qualify a pre-existing contact returned by create", async () => {
  const claim = await repo.claim("location", input());
  await repo.set(claim.id, { phase: "paused", contactId: contact.id }, "paused");
  await db.update(actionAttempts).set({ updatedAt: new Date(Date.now() - 61000) });
  mocks.get.mockResolvedValue({ ...contact, dateAdded: "2020-01-01T00:00:00.000Z" });
  expect((await reconcileDirectoryImport(claim.id)).status).toBe("paused"); expect(mocks.tags).not.toHaveBeenCalled();
});
it.each([
  { offset: -500, createdNew: undefined, expected: "paused" },
  { offset: 500, createdNew: undefined, expected: "succeeded" },
  { offset: 500, createdNew: false, expected: "paused" },
])("uses strict creation provenance during legacy recovery: %j", async ({ offset, createdNew, expected }) => {
  const claim = await repo.claim("location", input());
  const started = new Date(Date.now() - 120000);
  await repo.set(claim.id, { phase: "paused", contactId: contact.id, ...(createdNew === undefined ? {} : { createdNew }) }, "paused");
  await db.update(actionAttempts).set({ createdAt: started, updatedAt: new Date(Date.now() - 61000) });
  mocks.get.mockResolvedValue({ ...contact, dateAdded: new Date(started.getTime() + offset).toISOString() });
  expect((await reconcileDirectoryImport(claim.id)).status).toBe(expected);
  expect(mocks.tags).toHaveBeenCalledTimes(expected === "succeeded" ? 1 : 0);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.note).not.toHaveBeenCalled();
});

