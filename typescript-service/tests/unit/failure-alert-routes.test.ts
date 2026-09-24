import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/config/env";
const mocks = vi.hoisted(() => ({ run: vi.fn(), daily: vi.fn(), preflight: vi.fn() }));
vi.mock("@/lib/likes/failure-runtime", () => ({ runFailureAlerts: mocks.run, runDailyOutreachReport: mocks.daily, failurePreflight: mocks.preflight }));
import { GET as cron } from "@/app/api/cron/instagram-failures/route";
import { GET as dailyCron } from "@/app/api/cron/instagram-daily-report/route";
import { GET, POST } from "@/app/api/admin/instagram/alerts/route";
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture@localhost/test"); vi.stubEnv("ADMIN_API_TOKEN", "admin-secret-with-at-least-24-characters");
  vi.stubEnv("CRON_SECRET", "cron-secret-with-at-least-24-characters"); resetEnvCacheForTests(); vi.resetAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
it("requires the appropriate secret for inspection, tests and cron execution", async () => {
  for (const handler of [cron, dailyCron, GET, POST]) expect((await handler(new Request("https://example.test"))).status).toBe(401);
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.preflight).not.toHaveBeenCalled();
});
it("runs the authenticated daily report cron and surfaces uncertain delivery", async () => {
  mocks.daily.mockResolvedValue({ sent: 0, uncertain: 1 });
  const request = new Request("https://example.test", { headers: { Authorization: "Bearer cron-secret-with-at-least-24-characters" } });
  expect((await dailyCron(request)).status).toBe(503);
});
it("reports uncertain cron delivery as failure without exposing raw errors", async () => {
  mocks.run.mockResolvedValue({ sent: 0, uncertain: 1 });
  const request = new Request("https://example.test", { headers: { Authorization: "Bearer cron-secret-with-at-least-24-characters" } });
  expect((await cron(request)).status).toBe(503);
  mocks.run.mockRejectedValue(new Error("secret credential"));
  expect(await (await cron(request)).text()).not.toContain("secret credential");
});

