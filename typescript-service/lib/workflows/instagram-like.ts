import { sleep } from "workflow";
import { executeLikeStage, pauseLikeExecution } from "../likes/runtime";

export async function likeStageStep(id: string, stage: "start" | "observe" | "reconcile") {
  "use step";
  try { return await executeLikeStage(id, stage); }
  catch { throw new Error("Instagram like step failed; inspect the action ID"); }
}
export async function pauseLikeStep(id: string, reason: "poll_timeout" | "execution_failed") {
  "use step";
  try { return await pauseLikeExecution(id, reason); }
  catch { throw new Error("Could not record Instagram like pause"); }
}
export async function instagramLikeWorkflow(id: string, mode: "execute" | "reconcile" = "execute") {
  "use workflow";
  try {
    // Reconciliation can only observe an existing provider run or retry its GHL tag.
    let progress = await likeStageStep(id, mode === "execute" ? "start" : "observe");
    if (progress.state === "starting" || progress.state === "reserved") return await pauseLikeStep(id, "execution_failed");
    for (let poll = 0; progress.state === "polling" && poll < 20; poll++) {
      await sleep("15s");
      progress = await likeStageStep(id, "observe");
    }
    if (progress.state === "polling") return await pauseLikeStep(id, "poll_timeout");
    // Includes paused CRM reconciliation, but never starts another like.
    if (progress.state === "provider_succeeded" || (mode === "reconcile" && progress.state === "paused")) {
      return await likeStageStep(id, "reconcile");
    }
    return progress;
  } catch { return await pauseLikeStep(id, "execution_failed"); }
}

