import { z } from "zod";
import { ProviderError } from "../clients/errors";
import { likeTargetSchema } from "../likes/contracts";

export const LIKE_ACTOR = "dead00/instagram-like-bot";
export function likeEnvironmentAllowsWrites(env: Record<string, string | undefined> = process.env) {
  return env.IG_LIKE_ENABLED === "true" && env.OUTREACH_EMERGENCY_DISABLED === "false" && env.VERCEL_ENV === "production";
}

export function getLikeTarget(env: Record<string, string | undefined> = process.env) {
  const parsed = likeTargetSchema.safeParse({ accountId: env.IG_LIKE_ACCOUNT_ID,
    accountUsername: env.IG_LIKE_ACCOUNT_USERNAME, contactId: env.IG_LIKE_CONTACT_ID,
    targetUsername: env.IG_LIKE_TARGET_USERNAME, postUrl: env.IG_LIKE_POST_URL });
  if (!parsed.success) throw new Error("Invalid like pilot configuration");
  return parsed.data;
}

// Executed inside the sending step only. Never return these values from a step.
export function getLikeCookies(accountId: string, raw = process.env.IG_LIKE_COOKIES_JSON) {
  const cookie = z.object({ name: z.string().min(1).max(100), value: z.string().min(1).max(8192),
    domain: z.enum(["instagram.com", ".instagram.com"]).optional(), path: z.literal("/").optional(),
    expirationDate: z.number().finite().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
    sameSite: z.string().nullable().optional() });
  try {
    if (!raw || raw.length > 100_000) throw new Error();
    const cookies = z.array(cookie).min(3).max(100).parse(JSON.parse(raw));
    const names = new Set(cookies.map((item) => item.name));
    if (names.size !== cookies.length || !names.has("sessionid") || !names.has("csrftoken") ||
      cookies.find((item) => item.name === "ds_user_id")?.value !== accountId) throw new Error();
    const sessionId = cookies.find((item) => item.name === "sessionid")!.value;
    if (decodeURIComponent(sessionId).split(":")[0] !== accountId) throw new Error();
    for (const item of cookies) {
      if (["sessionid", "csrftoken", "ds_user_id"].includes(item.name) && item.expirationDate !== undefined &&
        item.expirationDate > 0 && item.expirationDate * 1000 <= Date.now()) throw new Error();
    }
    return cookies;
  } catch { throw new ProviderError("instagram-like", "invalid_input"); }
}

