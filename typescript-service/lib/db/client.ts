import { getCoreEnv } from "@/lib/config/env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

const globalForDb = globalThis as typeof globalThis & {
  peakspanSql?: SqlClient;
};

export function getSqlClient(): SqlClient {
  if (!globalForDb.peakspanSql) {
    globalForDb.peakspanSql = postgres(getCoreEnv().DATABASE_URL, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return globalForDb.peakspanSql;
}

export function getDb() {
  return drizzle(getSqlClient());
}

export async function checkDatabaseConnection() {
  await getSqlClient()`select 1`;
}
