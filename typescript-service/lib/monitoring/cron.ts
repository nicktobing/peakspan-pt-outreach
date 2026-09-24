import { MonitoringRepository } from "../db/monitoring";
import { scheduleWindow, type MonitoringJob } from "../domain/schedules";

export async function dispatchMonitoringCron(repository: MonitoringRepository, job: MonitoringJob, now: Date,
  start: (businessRunId: string) => Promise<string>, options: { enabled: boolean; reportHour: number }) {
  if (!options.enabled) return { status: "disabled" as const };
  const window = scheduleWindow(job, now, options.reportHour);
  if (!window) return { status: "outside_window" as const };
  const claim = await repository.claimWindow(job, window, now);
  if (!claim.acquired) return { status: "duplicate" as const, businessRunId: claim.run.id };
  try {
    const workflowRunId = await start(claim.run.id);
    await repository.recordDispatch(claim.run.id, workflowRunId);
    return { status: "accepted" as const, businessRunId: claim.run.id, workflowRunId };
  } catch {
    await repository.dispatchUncertain(claim.run.id);
    // Never release a claim after an uncertain start: the engine may be running.
    return { status: "dispatch_unknown" as const, businessRunId: claim.run.id };
  }
}

