import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/config/env";
import { POST } from "@/app/api/admin/pipeline/reconciliation-backfill/route";
import { createApprovedPipelineOpportunities } from "@/lib/pipeline/runtime";

vi.mock("@/lib/pipeline/runtime", async (load) => ({ ...(await load<typeof import("@/lib/pipeline/runtime")>()),
  createApprovedPipelineOpportunities: vi.fn(async () => ({ mode: "create_only", status: "complete", created: [] })) }));
const admin = "fixture-admin-token-with-enough-length";
const body = { confirmation: "create-approved-missing-opportunities", planId: "a".repeat(64) };
beforeEach(() => { vi.stubEnv("DATABASE_URL", "postgresql://fixture@localhost/fixture"); vi.stubEnv("ADMIN_API_TOKEN", admin);
  vi.stubEnv("CRON_SECRET", "fixture-cron-token-with-enough-length"); resetEnvCacheForTests(); });
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); vi.clearAllMocks(); });

describe("pipeline creation backfill route", () => {
  it("requires admin authentication and exact approval", async () => {
    expect((await POST(new Request("https://example.test/api/admin/pipeline/reconciliation-backfill", { method: "POST",
      body: JSON.stringify(body) }))).status).toBe(401);
    expect((await POST(new Request("https://example.test/api/admin/pipeline/reconciliation-backfill", { method: "POST",
      headers: { authorization: `Bearer ${admin}` }, body: JSON.stringify({ ...body, planId: "wrong" }) }))).status).toBe(400);
    expect(createApprovedPipelineOpportunities).not.toHaveBeenCalled();
  });
  it("executes only the exact authenticated creation approval", async () => {
    const response = await POST(new Request("https://example.test/api/admin/pipeline/reconciliation-backfill", { method: "POST",
      headers: { authorization: `Bearer ${admin}` }, body: JSON.stringify(body) }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ mode: "create_only", status: "complete" });
    expect(createApprovedPipelineOpportunities).toHaveBeenCalledWith(body);
  });
});
