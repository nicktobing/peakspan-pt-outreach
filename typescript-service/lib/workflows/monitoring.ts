import { executeMonitoring, recordMonitoringFailure } from "../monitoring/runtime";

export async function executeMonitoringStep(businessRunId: string) {
  "use step";
  try { return await executeMonitoring(businessRunId); }
  catch { throw new Error("Monitoring execution failed; inspect business state using its run ID"); }
}

export async function recordMonitoringFailureStep(businessRunId: string) {
  "use step";
  try { await recordMonitoringFailure(businessRunId); }
  catch { throw new Error("Could not record monitoring failure"); }
}

export async function monitoringWorkflow(businessRunId: string) {
  "use workflow";
  try { return await executeMonitoringStep(businessRunId); }
  catch {
    await recordMonitoringFailureStep(businessRunId);
    throw new Error("Monitoring run failed");
  }
}

