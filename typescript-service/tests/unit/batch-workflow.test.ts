import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ tick: vi.fn(), pause: vi.fn(), sleep: vi.fn() }));
vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("@/lib/likes/batch-runtime", () => ({ tickBatch: mocks.tick }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/like-batches", () => ({ LikeBatchRepository: class { pause = mocks.pause; } }));
import { instagramBatchWorkflow } from "@/lib/workflows/instagram-batch";
beforeEach(() => vi.resetAllMocks());
describe("batch delay and failure orchestration", () => {
  it("waits until the saved due time and carries through to the next step", async () => {
    mocks.tick.mockResolvedValueOnce({ state: "waiting", until: "2026-09-16T01:00:00Z" }).mockResolvedValueOnce({ state: "running" }).mockResolvedValueOnce({ state: "succeeded" });
    expect(await instagramBatchWorkflow("fixture")).toEqual({ state: "succeeded" });
    expect(mocks.sleep).toHaveBeenCalledWith(new Date("2026-09-16T01:00:00Z")); expect(mocks.tick).toHaveBeenCalledTimes(3);
  });
  it("stops on a paused action instead of carrying through or dropping its failure", async () => {
    mocks.tick.mockResolvedValue({ state: "paused" });
    expect(await instagramBatchWorkflow("fixture")).toEqual({ state: "paused" }); expect(mocks.tick).toHaveBeenCalledTimes(1);
  });
  it("persists an explicit pause after an exhausted step failure", async () => {
    mocks.tick.mockRejectedValue(new Error("provider private details"));
    expect(await instagramBatchWorkflow("fixture")).toEqual({ state: "paused" }); expect(mocks.pause).toHaveBeenCalledWith("fixture", "step_retries_exhausted");
  });
});

