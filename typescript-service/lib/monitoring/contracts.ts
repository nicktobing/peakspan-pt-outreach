import { z } from "zod";
import { businessHoursElapsed, type MonitoringJob } from "../domain/schedules";

export const identifier = z.string().trim().regex(/^[a-zA-Z0-9_.:-]+$/).max(250);
export const replySchema = z.object({ providerMessageId: identifier, contactId: identifier,
  receivedAt: z.date(), preview: z.string().max(500) });
export type IncomingReply = z.infer<typeof replySchema>;
export const escalationSchema = z.object({ id: z.string().uuid(), contactId: identifier,
  priority: z.enum(["high", "normal"]), createdAt: z.date(), resolvedAt: z.date().nullable() });
export const alertPayloadSchema = z.object({ kind: z.enum(["daily_report", "reply_monitor", "escalation_monitor"]),
  text: z.string().min(1).max(4000) }).strict();
export type AlertPayload = z.infer<typeof alertPayloadSchema>;
export interface AlertSink {
  enabled(): boolean;
  send(payload: AlertPayload): Promise<{ messageId: string }>;
}
export type RunSummary = { job: MonitoringJob; processed: number; queued: number; sent: number; uncertain: number; alertsEnabled: boolean };

export function escalationDecision(ticket: z.infer<typeof escalationSchema>, now: Date,
  hours: Parameters<typeof businessHoursElapsed>[2]) {
  const parsed = escalationSchema.parse(ticket);
  if (parsed.resolvedAt) return null;
  const elapsed = businessHoursElapsed(parsed.createdAt, now, hours);
  return { ...parsed, businessHours: elapsed, breached: elapsed >= 4, urgent: parsed.priority === "high" };
}

