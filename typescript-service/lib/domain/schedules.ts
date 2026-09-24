import { z } from "zod";

export const monitoringJobSchema = z.enum(["daily_report", "reply_monitor", "escalation_monitor"]);
export type MonitoringJob = z.infer<typeof monitoringJobSchema>;
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });

export function sydneyParts(instant: Date) {
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid schedule time");
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function dateOffset(date: string, days: number) {
  z.iso.date().parse(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// Used for unambiguous Sydney business-hour/day boundaries, never cron UTC offsets.
export function sydneyBoundary(date: string, hour = 0) {
  z.iso.date().parse(date);
  z.number().int().min(0).max(23).parse(hour);
  const target = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const local = sydneyParts(new Date(guess));
    const localEpoch = Date.parse(`${local.date}T${String(local.hour).padStart(2, "0")}:00:00Z`);
    const adjustment = target - localEpoch;
    if (!adjustment) return new Date(guess);
    guess += adjustment;
  }
  throw new Error("Nonexistent Sydney boundary");
}

export function scheduleWindow(job: MonitoringJob, now: Date, reportHour = 9) {
  monitoringJobSchema.parse(job);
  z.number().int().min(0).max(23).parse(reportHour);
  const local = sydneyParts(now);
  if (job === "daily_report" && local.hour !== reportHour) return null;
  if (job !== "daily_report" && local.hour % 2 !== 0) return null;
  // Autumn's repeated local hour deliberately maps to one business window.
  return job === "daily_report" ? local.date : `${local.date}T${String(local.hour).padStart(2, "0")}`;
}

export function previousSydneyDay(now: Date) {
  const today = sydneyParts(now).date;
  const date = dateOffset(today, -1);
  return { date, start: sydneyBoundary(date), end: sydneyBoundary(today) };
}

export const businessHoursSchema = z.object({
  startHour: z.number().int().min(0).max(22).default(9), endHour: z.number().int().min(1).max(23).default(17),
  holidays: z.array(z.iso.date()).default([]),
}).refine((hours) => hours.endHour > hours.startHour, "Invalid business hours");

export function businessHoursElapsed(createdAt: Date, now: Date, settings: z.input<typeof businessHoursSchema> = {}) {
  const calendar = businessHoursSchema.parse(settings);
  const first = sydneyParts(createdAt).date;
  const last = sydneyParts(now).date;
  if (now <= createdAt) return 0;
  let elapsed = 0;
  let date = first;
  for (let i = 0; date <= last; i++, date = dateOffset(date, 1)) {
    if (i > 3660) throw new Error("Escalation age exceeds supported range");
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || calendar.holidays.includes(date)) continue;
    const start = Math.max(createdAt.getTime(), sydneyBoundary(date, calendar.startHour).getTime());
    const end = Math.min(now.getTime(), sydneyBoundary(date, calendar.endHour).getTime());
    elapsed += Math.max(0, end - start);
  }
  return elapsed / 3_600_000;
}

