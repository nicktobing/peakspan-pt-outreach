import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/lib/config/env";
const mocks = vi.hoisted(() => ({ candidates: vi.fn(), fields: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/likes/batch-runtime", () => ({ batchCandidates: mocks.candidates, batchProfileFields: mocks.fields, prepareBatch: mocks.prepare, batchEnabled: () => false }));
import { GET, POST, PATCH } from "@/app/api/admin/instagram/batches/route";
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture@localhost/fixture"); vi.stubEnv("ADMIN_API_TOKEN", "fixture-admin-long-enough-to-validate");
  vi.stubEnv("CRON_SECRET", "fixture-cron-long-enough-to-validate"); resetEnvCacheForTests(); vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
describe("batch route authentication", () => {
  it("blocks inspection, discovery, execution and recovery without the admin credential", async () => {
    for (const handler of [GET, POST, PATCH]) expect((await handler(new Request("https://example.test?view=fields"))).status).toBe(401);
    expect(mocks.fields).not.toHaveBeenCalled(); expect(mocks.candidates).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

