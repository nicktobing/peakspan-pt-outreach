import { sleep } from "workflow";
import { tickBatch } from "../likes/batch-runtime";
import { getDb } from "../db/client";
import { LikeBatchRepository } from "../db/like-batches";

export async function batchTickStep(id: string) {
  "use step";
  try { return await tickBatch(id); }
  catch { throw new Error("Instagram session step failed; inspect session status"); }
}
export async function pauseBatchStep(id: string) {
  "use step";
  try { await new LikeBatchRepository(getDb()).pause(id, "step_retries_exhausted"); }
  catch { throw new Error("Could not persist Instagram session failure"); }
}
export async function instagramBatchWorkflow(id: string) {
  "use workflow";
  try {
    for (let step = 0; step < 3000; step++) {
      const result = await batchTickStep(id);
      if (result.state === "waiting") await sleep(new Date(result.until));
      else if (result.state !== "running") return result;
    }
    await pauseBatchStep(id); return { state: "paused" };
  } catch { await pauseBatchStep(id); return { state: "paused" }; }
}

