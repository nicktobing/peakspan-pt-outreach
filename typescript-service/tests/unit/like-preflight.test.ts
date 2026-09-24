import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/instagram/preflight/route";
import { resetEnvCacheForTests } from "@/lib/config/env";
const mocks = vi.hoisted(() => ({ contact: vi.fn(), suppressed: vi.fn(), setting: vi.fn() }));
vi.mock("@/lib/clients/ghl", () => ({ GhlClient: class { getContact = mocks.contact; } }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({ getActionSwitch: mocks.setting }));
vi.mock("@/lib/db/repositories", () => ({ ExecutionRepository: class { isSuppressed = mocks.suppressed; } }));
const admin = "fixture-admin-long-enough-for-validation";
beforeEach(() => {
  for (const [key, value] of Object.entries({ DATABASE_URL: "postgresql://fixture@localhost/fixture", ADMIN_API_TOKEN: admin,
    CRON_SECRET: "fixture-cron-long-enough-for-validation", IG_LIKE_ENABLED: "false", OUTREACH_EMERGENCY_DISABLED: "true",
    VERCEL_ENV: "production", IG_LIKE_ACCOUNT_ID: "123", IG_LIKE_ACCOUNT_USERNAME: "fixture_account",
    IG_LIKE_TARGET_USERNAME: "fixture_target", IG_LIKE_CONTACT_ID: "contact", IG_LIKE_POST_URL: "https://instagram.com/reel/Fixture/",
    IG_LIKE_COOKIES_JSON: JSON.stringify([{ name: "ds_user_id", value: "123" }, { name: "sessionid", value: "123:private" }, { name: "csrftoken", value: "private" }]),
    GHL_API_TOKEN: "private", GHL_LOCATION_ID: "location", APIFY_API_TOKEN: "private" })) vi.stubEnv(key, value);
  resetEnvCacheForTests(); vi.clearAllMocks();
  mocks.contact.mockResolvedValue({ id: "contact", tags: ["qualified"] });
  mocks.suppressed.mockResolvedValue(false); mocks.setting.mockResolvedValue({ disabled: true });
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
describe("read-only pilot preflight", () => {
  it("rejects unauthenticated reads before database or provider access", async () => {
    expect((await GET(new Request("https://example.test"))).status).toBe(401);
    expect(mocks.contact).not.toHaveBeenCalled(); expect(mocks.setting).not.toHaveBeenCalled();
  });
  it("checks the configured target while disabled without exposing secrets or claiming session validation", async () => {
    const response = await GET(new Request("https://example.test", { headers: { authorization: `Bearer ${admin}` } }));
    const body = await response.json();
    expect(body).toMatchObject({ environmentAllowsWrites: false, databaseAllowsWrites: false, cookiesValid: true,
      contactVerified: true, qualified: true, suppressed: false, instagramSessionVerified: false });
    expect(JSON.stringify(body)).not.toContain("private"); expect(fetch).not.toHaveBeenCalled();
  });
  it("reports invalid cookies and provider failure without leaking raw errors", async () => {
    vi.stubEnv("IG_LIKE_COOKIES_JSON", "malformed-private"); mocks.contact.mockRejectedValue(new Error("private-provider-error"));
    const body = await (await GET(new Request("https://example.test", { headers: { authorization: `Bearer ${admin}` } }))).json();
    expect(body).toMatchObject({ cookiesValid: false, contactVerified: false, suppressed: null });
    expect(JSON.stringify(body)).not.toContain("private");
  });
});

