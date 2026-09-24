import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { pathToFileURL } from "node:url";

export function bootstrapRequested(env) {
  if (env.OUTREACH_BOOTSTRAP_DATABASE !== "true") return false;
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "production" ||
      env.OUTREACH_EMERGENCY_DISABLED !== "true" || env.IG_LIKE_ENABLED !== "false" ||
      env.MONITORING_ENABLED !== "false" || env.MONITORING_ALERTS_ENABLED !== "false") {
    throw new Error("Database bootstrap requires a disabled Vercel production build");
  }
  if (!env.DATABASE_URL_UNPOOLED || env.DATABASE_URL_UNPOOLED === "[SENSITIVE]") {
    throw new Error("Database bootstrap requires its hosted unpooled connection");
  }
  return true;
}

const tables = ["action_attempts", "approval_batches", "escalation_queue", "inbound_events",
  "inbox_messages", "message_audit", "monitoring_alerts", "settings", "suppression_entries", "workflow_runs"];

export async function bootstrapDatabase(env = process.env) {
  if (!bootstrapRequested(env)) return;
  const sql = postgres(env.DATABASE_URL_UNPOOLED, { max: 1, prepare: false, connect_timeout: 15 });
  try {
    // A direct, single-session connection keeps concurrent bootstrap builds serialized.
    await sql`select pg_advisory_lock(784329105)`;
    const existing = await sql`select tablename from pg_tables where schemaname = 'public'`;
    if (existing.some((row) => !tables.includes(row.tablename))) {
      throw new Error("Unexpected database tables");
    }
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    const current = await sql`select tablename from pg_tables where schemaname = 'public'`;
    if (tables.some((name) => !current.some((row) => row.tablename === name))) {
      throw new Error("Schema verification failed");
    }
    await sql`insert into settings (key, value, updated_by)
      values ('outbound_disabled:like', '{"disabled":true,"reason":"Initial disabled deployment"}'::jsonb, 'bootstrap')
      on conflict (key) do nothing`;
    const [setting] = await sql`select value from settings where key = 'outbound_disabled:like'`;
    if (setting?.value?.disabled !== true) throw new Error("Like database switch must remain disabled");
    console.log("Database bootstrap verified: 10 service tables; like switch disabled.");
  } finally {
    // Closing the session releases its advisory lock, including on failures.
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapDatabase().catch(() => {
    console.error("Database bootstrap failed; deployment stopped. No credentials or database errors are logged.");
    process.exitCode = 1;
  });
}

