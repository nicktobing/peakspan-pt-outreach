import { evaluateOutboundPolicy } from "@/lib/domain/outbound";
import { describe, expect, it } from "vitest";

describe("outbound policy", () => {
  it("fails closed for the emergency switch", () => {
    expect(
      evaluateOutboundPolicy({
        env: { OUTREACH_EMERGENCY_DISABLED: true, VERCEL_ENV: "production" },
        actionDisabled: false,
      }),
    ).toEqual({ allowed: false, reason: "emergency_disabled" });
  });

  it("blocks preview deployments", () => {
    expect(
      evaluateOutboundPolicy({
        env: { OUTREACH_EMERGENCY_DISABLED: false, VERCEL_ENV: "preview" },
        actionDisabled: false,
      }),
    ).toEqual({ allowed: false, reason: "non_production" });
  });

  it("requires an explicit action enablement", () => {
    expect(
      evaluateOutboundPolicy({
        env: { OUTREACH_EMERGENCY_DISABLED: false, VERCEL_ENV: "production" },
      }),
    ).toEqual({ allowed: false, reason: "action_disabled" });
  });

  it("allows an explicitly enabled production action", () => {
    expect(
      evaluateOutboundPolicy({
        env: { OUTREACH_EMERGENCY_DISABLED: false, VERCEL_ENV: "production" },
        actionDisabled: false,
      }),
    ).toEqual({ allowed: true });
  });
});
