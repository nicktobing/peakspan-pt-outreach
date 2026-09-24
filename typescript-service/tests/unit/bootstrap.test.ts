import { describe, expect, it } from "vitest";
// The build script is also exercised by npm run build with bootstrap absent.
import { bootstrapRequested } from "../../scripts/bootstrap-db.mjs";

describe("hosted database bootstrap guard", () => {
  const disabled = { OUTREACH_BOOTSTRAP_DATABASE: "true", VERCEL: "1", VERCEL_ENV: "production",
    OUTREACH_EMERGENCY_DISABLED: "true", IG_LIKE_ENABLED: "false", MONITORING_ENABLED: "false",
    MONITORING_ALERTS_ENABLED: "false", DATABASE_URL_UNPOOLED: "postgresql://fixture@localhost/fixture" };
  it("does nothing for ordinary builds", () => { expect(bootstrapRequested({})).toBe(false); });
  it("requires a hosted, fully disabled production environment", () => {
    expect(bootstrapRequested(disabled)).toBe(true);
    for (const [key, value] of Object.entries({ VERCEL: "0", VERCEL_ENV: "preview",
      OUTREACH_EMERGENCY_DISABLED: "false", IG_LIKE_ENABLED: "true", MONITORING_ENABLED: "true",
      MONITORING_ALERTS_ENABLED: "true", DATABASE_URL_UNPOOLED: "[SENSITIVE]" })) {
      expect(() => bootstrapRequested({ ...disabled, [key]: value })).toThrow();
    }
  });
});

