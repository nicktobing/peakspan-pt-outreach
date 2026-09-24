import { describe, expect, it } from "vitest";
import { businessHoursElapsed, previousSydneyDay, scheduleWindow } from "@/lib/domain/schedules";
import { getMonitoringConfig } from "@/lib/config/monitoring";

describe("Sydney monitoring schedules", () => {
  it("keeps a daily report at 9am through DST changes", () => {
    expect(scheduleWindow("daily_report", new Date("2026-04-04T22:00:00Z"))).toBeNull();
    expect(scheduleWindow("daily_report", new Date("2026-04-04T23:00:00Z"))).toBe("2026-04-05");
    expect(scheduleWindow("daily_report", new Date("2026-10-03T22:00:00Z"))).toBe("2026-10-04");
  });
  it("deduplicates the repeated autumn hour and skips nonexistent spring hours", () => {
    expect(scheduleWindow("reply_monitor", new Date("2026-04-04T15:15:00Z"))).toBe("2026-04-05T02");
    expect(scheduleWindow("reply_monitor", new Date("2026-04-04T16:15:00Z"))).toBe("2026-04-05T02");
    expect(scheduleWindow("reply_monitor", new Date("2026-10-03T16:00:00Z"))).toBeNull();
  });
  it("reports full local days of 23 and 25 hours", () => {
    const autumn = previousSydneyDay(new Date("2026-04-05T23:00:00Z"));
    const spring = previousSydneyDay(new Date("2026-10-04T22:00:00Z"));
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
  });
  it("counts business hours across a weekend and configurable holidays", () => {
    const friday = new Date("2026-09-04T05:00:00Z"); // Friday 15:00 Sydney
    const monday = new Date("2026-09-07T01:00:00Z"); // Monday 11:00 Sydney
    expect(businessHoursElapsed(friday, monday)).toBe(4);
    expect(businessHoursElapsed(friday, monday, { holidays: ["2026-09-07"] })).toBe(2);
    expect(businessHoursElapsed(monday, friday)).toBe(0);
  });
  it("defaults both live operations and alerts off and blocks preview alerts", () => {
    expect(getMonitoringConfig({})).toMatchObject({ enabled: false, alertsEnabled: false });
    expect(getMonitoringConfig({ MONITORING_ENABLED: "true", MONITORING_ALERTS_ENABLED: "true", VERCEL_ENV: "preview" }).alertsEnabled).toBe(false);
    expect(() => getMonitoringConfig({ MONITORING_ENABLED: "yes" })).toThrow("Invalid monitoring configuration");
  });
});

