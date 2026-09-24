import type { CoreEnv } from "@/lib/config/env";
import { z } from "zod";

export const outboundActionSchema = z.enum([
  "like",
  "follow",
  "comment",
  "dm",
  "follow_up",
  "autonomous_reply",
]);

export type OutboundAction = z.infer<typeof outboundActionSchema>;

export type OutboundDecision =
  | { allowed: true }
  | { allowed: false; reason: "emergency_disabled" | "non_production" | "action_disabled" };

export function evaluateOutboundPolicy(input: {
  env: Pick<CoreEnv, "OUTREACH_EMERGENCY_DISABLED" | "VERCEL_ENV">;
  actionDisabled?: boolean;
}): OutboundDecision {
  if (input.env.OUTREACH_EMERGENCY_DISABLED) {
    return { allowed: false, reason: "emergency_disabled" };
  }
  if (input.env.VERCEL_ENV !== "production") {
    return { allowed: false, reason: "non_production" };
  }
  if (input.actionDisabled ?? true) {
    return { allowed: false, reason: "action_disabled" };
  }
  return { allowed: true };
}

