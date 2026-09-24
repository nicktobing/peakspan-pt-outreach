import { z } from "zod";

const schema = z.object({
  MONITORING_HOLIDAYS: z.string().default("").transform((value) => value ? value.split(",").map((date) => date.trim()) : []).pipe(z.array(z.iso.date())),
  MONITORING_ENABLED: z.enum(["true", "false"]).default("false"),
  MONITORING_ALERTS_ENABLED: z.enum(["true", "false"]).default("false"),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  MONITORING_REPORT_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  MONITORING_BUSINESS_START: z.coerce.number().int().min(0).max(22).default(9),
  MONITORING_BUSINESS_END: z.coerce.number().int().min(1).max(23).default(17),
}).refine((env) => env.MONITORING_BUSINESS_END > env.MONITORING_BUSINESS_START);

export function getMonitoringConfig(source: Record<string, string | undefined> = process.env) {
  const result = schema.safeParse(source);
  if (!result.success) throw new Error("Invalid monitoring configuration");
  const env = result.data;
  return { enabled: env.MONITORING_ENABLED === "true",
    alertsEnabled: env.MONITORING_ENABLED === "true" && env.MONITORING_ALERTS_ENABLED === "true" && env.VERCEL_ENV === "production",
    reportHour: env.MONITORING_REPORT_HOUR,
    businessHours: { holidays: env.MONITORING_HOLIDAYS, startHour: env.MONITORING_BUSINESS_START, endHour: env.MONITORING_BUSINESS_END },
  };
}


