const safeStringFields = new Set([
  "workflowRunId", "businessRunId", "contactId", "action",
  "providerExternalId", "status", "errorCode",
]);
const safeNumberFields = new Set(["count", "durationMs", "costUsd"]);
const events = [
  "service.started", "workflow.started", "workflow.completed", "workflow.failed",
  "auth.rejected", "database.unavailable", "outbound.blocked",
] as const;
type LogEvent = (typeof events)[number];

// Only diagnostic metadata belongs in logs. Payloads, messages, arbitrary error
// text, and URLs must stay out, even when their property names look harmless.
export function sanitizeLogContext(context: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => {
    if (safeStringFields.has(key) && typeof value === "string" &&
        /^[a-zA-Z0-9_.-]{1,200}$/.test(value)) {
      return [key, value];
    }
    if (safeNumberFields.has(key) && typeof value === "number" && Number.isFinite(value)) {
      return [key, value];
    }
    return [key, "[REDACTED]"];
  }).filter(([key]) => safeStringFields.has(key as string) || safeNumberFields.has(key as string)));
}

export function log(
  level: "info" | "warn" | "error",
  event: LogEvent,
  context: Record<string, unknown> = {},
) {
  const entry = JSON.stringify({
    ...sanitizeLogContext(context),
    level,
    event: events.includes(event) ? event : "[REDACTED]",
    timestamp: new Date().toISOString(),
  });
  const output = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  output(entry);
}

