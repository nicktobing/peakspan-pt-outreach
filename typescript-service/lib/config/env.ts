import { z } from "zod";

const secret = z.string().min(24);

const coreEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  DATABASE_URL: z.string().url(),
  CRON_SECRET: secret,
  ADMIN_API_TOKEN: secret,
  OUTREACH_EMERGENCY_DISABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type CoreEnv = z.infer<typeof coreEnvSchema>;

let cached: CoreEnv | undefined;

export function getCoreEnv(source: NodeJS.ProcessEnv = process.env): CoreEnv {
  if (source === process.env && cached) return cached;

  const result = coreEnvSchema.safeParse(source);
  if (!result.success) {
    const names = result.error.issues
      .map((issue) => issue.path.join("."))
      .filter(Boolean)
      .join(", ");
    throw new Error(`Invalid service environment: ${names}`);
  }

  if (source === process.env) cached = result.data;
  return result.data;
}

export function resetEnvCacheForTests() {
  cached = undefined;
}

