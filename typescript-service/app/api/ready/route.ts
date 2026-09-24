import { checkDatabaseConnection } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await checkDatabaseConnection();
    return Response.json({ status: "ready", database: "connected" });
  } catch {
    return Response.json(
      { status: "not_ready", database: "unavailable" },
      { status: 503 },
    );
  }
}
