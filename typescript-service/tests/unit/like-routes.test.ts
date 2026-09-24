import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/config/env";
import { POST, GET } from "@/app/api/admin/instagram/like/route";
import { POST as reconcile } from "@/app/api/admin/instagram/like/reconcile/route";

vi.mock("@/lib/likes/runtime", () => ({ canStartLike: vi.fn(async () => false) }));
const admin = "fixture-admin-token-with-enough-length";
const request = (body?: unknown, token = admin) => new Request("https://example.test/api/admin/instagram/like", {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});
beforeEach(() => {
  const env = { DATABASE_URL: "postgresql://fixture:fixture@localhost:1/never-connect", ADMIN_API_TOKEN: admin,
    CRON_SECRET: "fixture-cron-token-with-enough-length", IG_LIKE_ENABLED: "false", OUTREACH_EMERGENCY_DISABLED: "true",
    VERCEL_ENV: "preview", IG_LIKE_ACCOUNT_ID: "123", IG_LIKE_ACCOUNT_USERNAME: "fixture_account", IG_LIKE_CONTACT_ID: "contact",
    IG_LIKE_TARGET_USERNAME: "fixture_target", IG_LIKE_POST_URL: "https://www.instagram.com/reel/Fixture123/" };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("GHL_WEBHOOK_SECRET", undefined);
  vi.stubEnv("SLACK_SIGNING_SECRET", undefined);
  resetEnvCacheForTests();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
describe("like HTTP boundaries", () => {
  it("requires the admin token for start, status and reconciliation", async () => {
    expect((await POST(request({}, "wrong"))).status).toBe(401);
    expect((await GET(new Request("https://example.test?id=bad"))).status).toBe(401);
    expect((await reconcile(request({}, "fixture-cron-token-with-enough-length"))).status).toBe(401);
  });
  it("stays disabled without DB or provider access", async () => {
    expect(await (await POST(request())).json()).toEqual({ status: "disabled" });
    expect(await (await reconcile(request())).json()).toEqual({ status: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects arbitrary targets and cookie-bearing request payloads", async () => {
    vi.stubEnv("IG_LIKE_ENABLED", "true"); vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "false"); vi.stubEnv("VERCEL_ENV", "production");
    expect((await POST(request({ contactId: "contact", postUrl: "https://instagram.com/reel/Wrong/" }))).status).toBe(403);
    expect((await POST(request({ contactId: "wrong", postUrl: "https://instagram.com/reel/Fixture123/" }))).status).toBe(403);
    expect((await POST(request({ contactId: "contact", postUrl: "https://instagram.com/reel/Fixture123/", cookies: [] }))).status).toBe(400);
    expect((await POST(request({ contactId: "contact", postUrl: "https://instagram.com/reel/Fixture123/" }))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed status IDs and JSON", async () => {
    expect((await GET(new Request("https://example.test?id=bad", { headers: { authorization: `Bearer ${admin}` } }))).status).toBe(400);
    vi.stubEnv("IG_LIKE_ENABLED", "true"); vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "false"); vi.stubEnv("VERCEL_ENV", "production");
    expect((await POST(new Request("https://example.test", { method: "POST", headers: { authorization: `Bearer ${admin}` }, body: "{" }))).status).toBe(400);
  });
});

