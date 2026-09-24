import { z } from "zod";

export const campaignContactSchema = z.object({
  tags: z.array(z.string()), suppressed: z.boolean(),
  outreachDate: z.iso.datetime({ offset: true }).nullable().default(null),
  followupCount: z.number().int().min(0).max(3).default(0),
});
const stopTags = ["opted-out", "responded", "ig-responded", "cold", "escalated", "disqualified"];
export function isSuppressed(tags: string[], suppressed: boolean) {
  const normalized = new Set(tags.map((tag) => tag.trim().toLowerCase()));
  return suppressed || stopTags.some((tag) => normalized.has(tag));
}
export function actionEligible(value: unknown, action: "follow" | "comment_1" | "comment_2" | "comment_3" | "dm") {
  const input = campaignContactSchema.parse(value);
  const tags = new Set(input.tags.map((tag) => tag.trim().toLowerCase()));
  if (isSuppressed(input.tags, input.suppressed)) return false;
  const rules = {
    follow: ["qualified", "ig-followed"], comment_1: ["ig-followed", "ig-comment-1"],
    comment_2: ["ig-comment-1", "ig-comment-2"], comment_3: ["ig-comment-2", "ig-comment-3"],
    dm: ["ig-comment-3", "ig-dm-sent"],
  } as const;
  const [required, completed] = rules[action];
  return tags.has(required) && !tags.has(completed) && !(action === "dm" && tags.has("outreach-sent"));
}
export function followupDue(value: unknown, now: Date) {
  const input = campaignContactSchema.parse(value);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  if (isSuppressed(input.tags, input.suppressed) || !input.outreachDate) return null;
  const days = Math.floor((now.getTime() - Date.parse(input.outreachDate)) / 86_400_000);
  if (input.followupCount === 3) return days >= 15 ? { action: "move_to_cold" as const } : null;
  if (days < [3, 7, 14][input.followupCount]) return null;
  return { action: "send_followup" as const, number: input.followupCount + 1, maxWords: input.followupCount === 2 ? 80 : 100 };
}

