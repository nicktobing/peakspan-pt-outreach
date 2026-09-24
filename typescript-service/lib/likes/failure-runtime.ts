import { SlackClient } from "../clients/slack";
import { getDb } from "../db/client";
import { OUTREACH_REPORT_CHANNEL, FailureAlertRepository } from "./failure-alerts";
import { sydneyParts } from "../domain/schedules";
export const LIVE_FAILURE_MEMBER_ID = "U09N5128R0T";

export function failureAlertsEnabled() {
  return process.env.VERCEL_ENV === "production" && process.env.IG_FAILURE_ALERTS_ENABLED === "true";
}
function slack(channel: string) {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error("Slack destination not configured");
  return new SlackClient(process.env.SLACK_BOT_TOKEN, channel, { authorizeWrite: async () => failureAlertsEnabled() });
}
export async function reportPreflight() {
  if (process.env.SLACK_CHANNEL_OUTREACH !== OUTREACH_REPORT_CHANNEL) throw new Error("Slack destination not configured");
  const client = slack(OUTREACH_REPORT_CHANNEL); const identity = await client.identity();
  const teamMatches = Boolean(process.env.SLACK_TEAM_ID) && identity.teamId === process.env.SLACK_TEAM_ID;
  if (!identity.isBot || !teamMatches) throw new Error("Slack workspace not verified");
  return { ...identity, reportChannelId: OUTREACH_REPORT_CHANNEL, enabled: failureAlertsEnabled(), teamMatches };
}
export async function failurePreflight() {
  if (process.env.SLACK_LIVE_FAILURE_MEMBER_ID !== LIVE_FAILURE_MEMBER_ID) throw new Error("Slack destination not configured");
  const report = await reportPreflight(); const liveChannelId = await slack(OUTREACH_REPORT_CHANNEL).openDirectMessage(LIVE_FAILURE_MEMBER_ID);
  return { ...report, liveMemberId: LIVE_FAILURE_MEMBER_ID, liveChannelId };
}
export async function runFailureAlerts(testId?: string) {
  if (!failureAlertsEnabled()) return { disabled: true };
  const identity = await failurePreflight();
  if (!identity.isBot || !identity.teamMatches) throw new Error("Slack workspace not verified");
  const repository = new FailureAlertRepository(getDb());
  const alertId = testId ? await repository.test(testId) : undefined;
  const queued = await repository.collect();
  const delivery = await repository.drain({ channelId: identity.liveChannelId, enabled: failureAlertsEnabled,
    send: (text) => slack(identity.liveChannelId).postMessage(text) });
  return { queued, ...delivery, ...(alertId ? { test: await repository.read(alertId) } : {}) };
}
export async function runDailyOutreachReport(now = new Date()) {
  if (!failureAlertsEnabled()) return { disabled: true };
  const inReportWindow = sydneyParts(now).hour === 17;
  const repository = new FailureAlertRepository(getDb());
  const reportId = inReportWindow ? await repository.enqueueDailySummary(now) : undefined;
  const identity = await reportPreflight();
  if (!identity.isBot || !identity.teamMatches) throw new Error("Slack workspace not verified");
  const delivery = await repository.drain({ channelId: OUTREACH_REPORT_CHANNEL, enabled: failureAlertsEnabled,
    send: (text) => slack(OUTREACH_REPORT_CHANNEL).postMessage(text) }, "instagram_daily_summary");
  return { ...(reportId ? { reportId } : { outsideWindow: true }), ...delivery };
}

