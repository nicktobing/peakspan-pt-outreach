import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/config/env";
import { GET } from "@/app/api/admin/pipeline/reconciliation-preview/route";
import { previewPipelineReconciliation } from "@/lib/pipeline/runtime";

vi.mock("@/lib/pipeline/runtime", () => ({ previewPipelineReconciliation: vi.fn(async () => ({ mode: "read_only", counts: { eligible: 3 } })) }));
const admin = "fixture-admin-token-with-enough-length";
beforeEach(() => { vi.stubEnv("DATABASE_URL", "postgresql://fixture@localhost/fixture"); vi.stubEnv("ADMIN_API_TOKEN", admin);
  vi.stubEnv("CRON_SECRET", "fixture-cron-token-with-enough-length"); resetEnvCacheForTests(); });
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); vi.clearAllMocks(); });

describe("pipeline reconciliation preview route", () => {
  it("requires admin authentication", async () => {
    expect((await GET(new Request("https://example.test/api/admin/pipeline/reconciliation-preview"))).status).toBe(401);
    expect(previewPipelineReconciliation).not.toHaveBeenCalled();
  });
  it("returns only the read-only preview", async () => {
    const response = await GET(new Request("https://example.test/api/admin/pipeline/reconciliation-preview",
      { headers: { authorization: `Bearer ${admin}` } }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ mode: "read_only", counts: { eligible: 3 } });
    expect(previewPipelineReconciliation).toHaveBeenCalledTimes(1);
  });
});
