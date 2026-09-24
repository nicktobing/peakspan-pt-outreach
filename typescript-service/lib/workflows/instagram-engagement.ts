import { sleep } from "workflow";
import { executeEngagementStage, pauseEngagement } from "../engagement/runtime";

export async function engagementStageStep(id: string, stage: "start" | "observe" | "reconcile") {
  "use step";
  try { return await executeEngagementStage(id, stage); } catch { throw new Error("Instagram engagement step failed; inspect the action ID"); }
}
export async function pauseEngagementStep(id: string, reason: "poll_timeout" | "execution_failed") {
  "use step";
  try { return await pauseEngagement(id, reason); } catch { throw new Error("Could not record Instagram engagement pause"); }
}
export async function instagramEngagementWorkflow(id: string, mode: "execute" | "reconcile" = "execute") {
  "use workflow";
  try {
    let progress = await engagementStageStep(id, mode === "execute" ? "start" : "observe");
    if (progress.state === "starting" || progress.state === "reserved") return pauseEngagementStep(id, "execution_failed");
    for (let poll = 0; progress.state === "polling" && poll < 40; poll++) { await sleep("15s"); progress = await engagementStageStep(id, "observe"); }
    if (progress.state === "polling") return pauseEngagementStep(id, "poll_timeout");
    if (progress.state === "provider_succeeded" || (mode === "reconcile" && progress.state === "paused")) return engagementStageStep(id, "reconcile");
    return progress;
  } catch { return pauseEngagementStep(id, "execution_failed"); }
}

