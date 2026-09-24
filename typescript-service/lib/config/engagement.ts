import { z } from "zod";
import { getLikeCookies } from "./likes";
import type { EngagementAction } from "../engagement/contracts";

export const FOLLOW_ACTOR = "synk/instagram-auto-follow";
export const COMMENT_ACTOR = "mikolabs/ig-post-reel-comment-bot";
export const DM_ACTOR = "rhymed_jellyfish/instagram-dm-automation-messages";

export function engagementEnvironmentAllowsWrites(action: EngagementAction, env: Record<string, string | undefined> = process.env) {
  const name = action === "follow" ? "IG_FOLLOW_ENABLED" : action === "dm" ? "IG_DM_ENABLED" : "IG_COMMENT_ENABLED";
  if (env[name] !== "true" || env.OUTREACH_EMERGENCY_DISABLED !== "false" || env.VERCEL_ENV !== "production") return false;
  return action !== "dm" || env.IG_DM_PROVIDER_VALIDATED === "true";
}
export function engagementAccount(env: Record<string, string | undefined> = process.env) {
  return z.object({ accountId: z.string().regex(/^[1-9][0-9]{0,29}$/), accountUsername: z.string().min(1) }).parse({
    accountId: env.IG_LIKE_ACCOUNT_ID, accountUsername: env.IG_LIKE_ACCOUNT_USERNAME,
  });
}
export function engagementCookies(accountId: string) { return getLikeCookies(accountId); }
export function engagementSessionId(accountId: string) {
  const value = engagementCookies(accountId).find((cookie) => cookie.name === "sessionid")?.value;
  if (!value) throw new Error("Missing Instagram session");
  return value;
}

