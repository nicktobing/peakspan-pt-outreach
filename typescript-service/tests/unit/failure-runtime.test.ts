import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), open: vi.fn(), send: vi.fn(), db: vi.fn(), enqueueDaily: vi.fn(), drain: vi.fn(),
  collect: vi.fn(), test: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/clients/slack", () => ({ SlackClient: class { identity = mocks.identity; openDirectMessage = mocks.open; postMessage = mocks.send; } }));
vi.mock("@/lib/db/client", () => ({ getDb: mocks.db }));
vi.mock("@/lib/likes/failure-alerts", () => ({ OUTREACH_REPORT_CHANNEL: "C0B047Q4DEU", FailureAlertRepository: class {
  enqueueDailySummary = mocks.enqueueDaily; drain = mocks.drain; collect = mocks.collect; test = mocks.test; read = mocks.read;
} }));
import { runDailyOutreachReport, runFailureAlerts, failurePreflight, reportPreflight } from "@/lib/likes/failure-runtime";
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it("does nothing outside enabled Production, even with an Instagram account enabled", async () => {
  vi.stubEnv("IG_LIKE_ENABLED", "true"); vi.stubEnv("IG_FAILURE_ALERTS_ENABLED", "false");
  expect(await runFailureAlerts()).toEqual({ disabled: true }); expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
});
it("checks the exact channel, bot identity and pinned workspace before queuing or sending", async () => {
  vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("IG_FAILURE_ALERTS_ENABLED", "true"); vi.stubEnv("SLACK_BOT_TOKEN", "fixture");
  vi.stubEnv("SLACK_LIVE_FAILURE_MEMBER_ID", "U09N5128R0T"); mocks.open.mockResolvedValue("DPRIVATE");
  vi.stubEnv("SLACK_CHANNEL_OUTREACH", "WRONG"); vi.stubEnv("SLACK_TEAM_ID", "TEXPECTED");
  await expect(runFailureAlerts()).rejects.toThrow("destination");
  vi.stubEnv("SLACK_CHANNEL_OUTREACH", "C0B047Q4DEU");
  mocks.identity.mockResolvedValue({ teamName: "Other", teamId: "TOTHER", isBot: true });
  await expect(runFailureAlerts()).rejects.toThrow("workspace");
  mocks.identity.mockResolvedValue({ teamName: "Peakspan", teamId: "TEXPECTED", isBot: false });
  await expect(runFailureAlerts()).rejects.toThrow("workspace"); expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  mocks.identity.mockResolvedValue({ teamName: "Peakspan", teamId: "TEXPECTED", isBot: true });
  vi.stubEnv("IG_LIKE_ENABLED", "false"); vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "true");
  expect(await failurePreflight()).toMatchObject({ enabled: true, teamMatches: true, liveMemberId: "U09N5128R0T", liveChannelId: "DPRIVATE",
    reportChannelId: "C0B047Q4DEU" });
});
it("rejects another valid workspace member and keeps shared reporting independent of DM resolution", async () => {
  vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("IG_FAILURE_ALERTS_ENABLED", "true"); vi.stubEnv("SLACK_BOT_TOKEN", "fixture");
  vi.stubEnv("SLACK_CHANNEL_OUTREACH", "C0B047Q4DEU"); vi.stubEnv("SLACK_TEAM_ID", "TEXPECTED");
  mocks.identity.mockResolvedValue({ teamName: "Peakspan", teamId: "TEXPECTED", isBot: true }); mocks.open.mockRejectedValue(new Error("DM unavailable"));
  vi.stubEnv("SLACK_LIVE_FAILURE_MEMBER_ID", "UOTHER123");
  await expect(failurePreflight()).rejects.toThrow("destination"); expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  expect(await reportPreflight()).toMatchObject({ reportChannelId: "C0B047Q4DEU", teamMatches: true }); expect(mocks.open).not.toHaveBeenCalled();
});
it("creates the daily summary at 17:00 and retries a pending definitive rejection on the next hourly cron", async () => {
  vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("IG_FAILURE_ALERTS_ENABLED", "true"); vi.stubEnv("SLACK_BOT_TOKEN", "fixture");
  vi.stubEnv("SLACK_CHANNEL_OUTREACH", "C0B047Q4DEU"); vi.stubEnv("SLACK_TEAM_ID", "TEXPECTED");
  mocks.identity.mockResolvedValue({ teamName: "Peakspan", teamId: "TEXPECTED", isBot: true }); mocks.enqueueDaily.mockResolvedValue("report-id");
  mocks.drain.mockResolvedValueOnce({ sent: 0, uncertain: 0 }).mockResolvedValueOnce({ sent: 1, uncertain: 0 });
  expect(await runDailyOutreachReport(new Date("2026-09-17T07:00:00Z"))).toMatchObject({ reportId: "report-id", sent: 0 });
  expect(await runDailyOutreachReport(new Date("2026-09-17T08:00:00Z"))).toMatchObject({ outsideWindow: true, sent: 1 });
  expect(mocks.enqueueDaily).toHaveBeenCalledTimes(1); expect(mocks.drain).toHaveBeenCalledTimes(2); expect(mocks.open).not.toHaveBeenCalled();
});
it("persists the 17:00 report before Slack preflight so an 18:00 run can recover it", async () => {
  vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("IG_FAILURE_ALERTS_ENABLED", "true"); vi.stubEnv("SLACK_BOT_TOKEN", "fixture");
  vi.stubEnv("SLACK_CHANNEL_OUTREACH", "C0B047Q4DEU"); vi.stubEnv("SLACK_TEAM_ID", "TEXPECTED");
  mocks.enqueueDaily.mockResolvedValue("report-id"); mocks.identity.mockRejectedValueOnce(new Error("temporary Slack failure"))
    .mockResolvedValueOnce({ teamName: "Peakspan", teamId: "TEXPECTED", isBot: true });
  mocks.drain.mockResolvedValue({ sent: 1, uncertain: 0 });
  await expect(runDailyOutreachReport(new Date("2026-09-17T07:00:00Z"))).rejects.toThrow("temporary Slack failure");
  expect(await runDailyOutreachReport(new Date("2026-09-17T08:00:00Z"))).toMatchObject({ outsideWindow: true, sent: 1 });
  expect(mocks.enqueueDaily).toHaveBeenCalledTimes(1); expect(mocks.drain).toHaveBeenCalledTimes(1); expect(mocks.open).not.toHaveBeenCalled();
});

