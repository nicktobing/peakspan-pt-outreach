import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/config/env";
const mocks = vi.hoisted(() => ({ fields: vi.fn(), contacts: vi.fn() }));
vi.mock("@/lib/clients/ghl", () => ({ GhlClient: class { listCustomFields = mocks.fields; listContacts = mocks.contacts; } }));
import { POST } from "@/app/api/admin/leads/screen/route";
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture@localhost/fixture"); vi.stubEnv("ADMIN_API_TOKEN", "fixture-admin-long-enough-to-validate");
  vi.stubEnv("CRON_SECRET", "fixture-cron-long-enough-to-validate"); resetEnvCacheForTests(); vi.clearAllMocks();
  mocks.fields.mockResolvedValue([]); mocks.contacts.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
function request(body: unknown, authorized = true) { return new Request("https://example.test/api/admin/leads/screen", {
  method: "POST", headers: authorized ? { Authorization: "Bearer fixture-admin-long-enough-to-validate" } : {}, body: JSON.stringify(body) }); }
it("requires authentication before reading lead data or querying GHL", async () => {
  expect((await POST(request({ leads: [{}] }, false))).status).toBe(401); expect(mocks.contacts).not.toHaveBeenCalled();
});
it("fails closed without a partial result when GHL fails", async () => {
  mocks.contacts.mockRejectedValue(new Error("private provider response"));
  const response = await POST(request({ leads: [{ instagram_url: "test_gym" }] }));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("private");
});
it("validates rows and returns an uncached read-only screening snapshot", async () => {
  expect((await POST(request({ leads: [] }))).status).toBe(400);
  const response = await POST(request({ leads: [{ instagram_url: "test_gym" }] }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).counts).toEqual({ new_needs_qualification: 1 });
});

