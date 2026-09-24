import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/dry-run/route";
import { GET } from "@/app/api/cron/monitoring/[job]/route";
import { resetEnvCacheForTests } from "@/lib/config/env";

const admin = "fixture-admin-token-with-enough-length";
const cron = "fixture-cron-token-with-enough-length";
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:1/never-connect");
  vi.stubEnv("ADMIN_API_TOKEN", admin); vi.stubEnv("CRON_SECRET", cron);
  vi.stubEnv("GHL_WEBHOOK_SECRET", "fixture-webhook-secret-long-enough");
  vi.stubEnv("SLACK_SIGNING_SECRET", "fixture-slack-secret-long-enough");
  vi.stubEnv("MONITORING_ENABLED", "false"); resetEnvCacheForTests();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });

describe("monitoring HTTP boundaries", () => {
  it("requires the separate admin token for dry runs", async () => {
    expect((await POST(new Request("https://example.test", { method: "POST" }))).status).toBe(401);
    expect((await POST(new Request("https://example.test", { method: "POST", headers: { authorization: `Bearer ${cron}` } }))).status).toBe(401);
  });
  it("returns snapshot decisions without database or provider access", async () => {
    const result = await POST(new Request("https://example.test", { method: "POST", headers: { authorization: `Bearer ${admin}` },
      body: JSON.stringify({ contact: { tags: ["qualified"], suppressed: false } }) }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ simulation: true, authorizesSending: false, eligibility: { follow: true, dm: false } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed snapshots", async () => {
    const result = await POST(new Request("https://example.test", { method: "POST", headers: { authorization: `Bearer ${admin}` }, body: "{" }));
    expect(result.status).toBe(400);
  });
  it("authenticates cron requests and stays disabled without touching dependencies", async () => {
    const context = { params: Promise.resolve({ job: "daily_report" }) };
    expect((await GET(new Request("https://example.test"), context)).status).toBe(401);
    const response = await GET(new Request("https://example.test", { headers: { authorization: `Bearer ${cron}` } }), context);
    expect(await response.json()).toEqual({ status: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

