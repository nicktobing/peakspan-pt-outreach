import { z } from "zod";
import { MonitoringRepository } from "../db/monitoring";
import { idempotencyKey } from "../domain/idempotency";
import { monitoringJobSchema, previousSydneyDay, type MonitoringJob } from "../domain/schedules";
import { ProviderError } from "../clients/errors";
import { alertPayloadSchema, escalationDecision, escalationSchema, identifier, type AlertSink, type IncomingReply, type RunSummary } from "./contracts";

export type MonitoringSources = {
  pipelineId: string;
  opportunities(): Promise<unknown>;
  replies(): Promise<IncomingReply[]>;
};
export type MonitorOptions = { enabled(): boolean; businessHours: { startHour: number; endHour: number; holidays?: string[] } };

export async function drainAlerts(repository: MonitoringRepository, job: MonitoringJob, sink: AlertSink) {
  let sent = 0; let uncertain = 0;
  if (!sink.enabled()) return { sent, uncertain };
  for (const alert of await repository.pendingAlerts(job)) {
    if (!sink.enabled()) break;
    const payload = alertPayloadSchema.parse(alert.payload);
    if (!(await repository.claimAlert(alert.id))) continue;
    try {
      const result = await sink.send(payload);
      const messageId = z.string().min(1).max(250).parse(result.messageId);
      await repository.finishAlert(alert.id, "sent", messageId);
      sent++;
    } catch (error) {
      // Only a known pre-send denial may return to pending. Every other failure
      // could have followed delivery, so retries require human reconciliation.
      const denied = error instanceof ProviderError && error.kind === "disabled";
      await repository.finishAlert(alert.id, denied ? "pending" : "unknown");
      if (!denied) uncertain++;
      break;
    }
  }
  return { sent, uncertain };
}

export async function executeMonitoringRun(repository: MonitoringRepository, runId: string,
  sources: MonitoringSources, sink: AlertSink, options: MonitorOptions): Promise<RunSummary | { disabled: true }> {
  const run = await repository.getRun(runId);
  const job = monitoringJobSchema.parse(run.workflow);
  if (run.status === "succeeded") return run.result as RunSummary;
  if (!options.enabled()) { await repository.pause(runId); return { disabled: true }; }
  if (!["pending", "running"].includes(run.status)) throw new Error("Monitoring run requires reconciliation");
  await repository.running(runId);
  const now = run.createdAt;
  let queued = 0; let processed = 0;
  if (job === "daily_report") {
    const period = previousSydneyDay(now);
    const totals = await repository.executionTotals(period.start, period.end);
    if (!options.enabled()) { await repository.pause(runId); return { disabled: true }; }
    const pipelineId = identifier.parse(sources.pipelineId);
    const opportunities = z.array(z.object({ id: identifier, pipelineId: identifier, pipelineStageId: identifier })).parse(await sources.opportunities());
    const ids = new Set<string>(); const stages = new Map<string, number>();
    for (const opportunity of opportunities) {
      if (opportunity.pipelineId !== pipelineId) throw new Error("Unexpected pipeline in report");
      if (ids.has(opportunity.id)) throw new Error("Duplicate opportunity in report");
      ids.add(opportunity.id); stages.set(opportunity.pipelineStageId, (stages.get(opportunity.pipelineStageId) ?? 0) + 1);
    }
    processed = opportunities.length;
    const cost = totals.actions.reduce((sum, group) => sum + Number(group.cost), 0);
    const missing = totals.actions.reduce((sum, group) => sum + group.missingCost, 0);
    const text = `Daily report for ${period.date} (Australia/Sydney).\n` +
      `Execution actions: ${JSON.stringify(Object.fromEntries(totals.actions.map((group) => [group.status, group.count])))}.\n` +
      `Business runs: ${JSON.stringify(Object.fromEntries(totals.runs.map((group) => [group.status, group.count])))}.\n` +
      `Known cost: USD ${cost.toFixed(6)}; ${missing} actions with unknown cost.\n` +
      `Current pipeline snapshot: ${processed} opportunities. Stages: ${JSON.stringify(Object.fromEntries(stages))}.`;
    queued += Number(await repository.enqueueAlert(idempotencyKey("daily-report", pipelineId, period.date), { kind: job, text }));
  } else if (job === "reply_monitor") {
    const replies = await sources.replies();
    for (const reply of replies) {
      if (!options.enabled()) { await repository.pause(runId); return { disabled: true }; }
      queued += Number(await repository.processReply(reply)); processed++;
    }
  } else {
    const tickets = z.array(escalationSchema).parse(await repository.openEscalations());
    processed = tickets.length;
    for (const ticket of tickets) {
      const decision = escalationDecision(ticket, now, options.businessHours);
      if (!decision) continue;
      const key = decision.breached ? idempotencyKey("sla-reminder", ticket.id, run.scheduledWindow!) : idempotencyKey("escalation-open", ticket.id);
      queued += Number(await repository.enqueueAlert(key, { kind: job,
        text: `Escalation ${ticket.id} for contact ${ticket.contactId}: ${ticket.priority} priority. ` +
          `${decision.breached ? "Four-business-hour SLA breached" : "Human response required"}. Review the queue; no automated reply has been sent.` }));
    }
    if (tickets.length > 10) queued += Number(await repository.enqueueAlert(idempotencyKey("escalation-backlog", run.scheduledWindow!), {
      kind: job, text: `Escalation backlog: ${tickets.length} unresolved tickets. Assign additional support.`,
    }));
  }
  if (!options.enabled()) { await repository.pause(runId); return { disabled: true }; }
  const delivery = await drainAlerts(repository, job, sink);
  const summary: RunSummary = { job, processed, queued, ...delivery, alertsEnabled: sink.enabled() };
  await repository.finish(runId, summary);
  return summary;
}


