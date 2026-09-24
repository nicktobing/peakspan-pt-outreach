import { z } from "zod";
import { instagramUsername, likeTargetSchema, postUrlSchema } from "../likes/contracts";
import { checkMessage } from "../domain/compliance";

export const engagementActionSchema = z.enum(["follow", "comment_1", "comment_2", "comment_3", "dm"]);
export type EngagementAction = z.infer<typeof engagementActionSchema>;

const base = z.object({
  accountId: likeTargetSchema.shape.accountId,
  accountUsername: instagramUsername,
  contactId: likeTargetSchema.shape.contactId,
  targetUsername: instagramUsername,
});
export const followTargetSchema = base.extend({ action: z.literal("follow") }).strict();
export const commentTargetSchema = base.extend({
  action: z.enum(["comment_1", "comment_2", "comment_3"]),
  postUrl: postUrlSchema,
  text: z.string().trim().min(1).max(500).superRefine((text, ctx) => {
    const result = checkMessage(text, 20);
    if (!result.compliant) ctx.addIssue({ code: "custom", message: result.violations.join(",") });
    if (/[{}|]/.test(text)) ctx.addIssue({ code: "custom", message: "Comment variations are not allowed" });
  }),
}).strict();
export const dmTargetSchema = base.extend({
  action: z.literal("dm"), approvalBatchId: z.uuid(),
  text: z.string().trim().min(1).max(1500).superRefine((text, ctx) => {
    const result = checkMessage(text, 100);
    if (!result.compliant) ctx.addIssue({ code: "custom", message: result.violations.join(",") });
    if (!/\bpeakspan\b/i.test(text)) ctx.addIssue({ code: "custom", message: "PeakSpan identification is required" });
    if (!/\b(affiliate|referral)\b/i.test(text)) ctx.addIssue({ code: "custom", message: "Affiliate or referral framing is required" });
  }),
}).strict();
export const engagementTargetSchema = z.discriminatedUnion("action", [followTargetSchema, commentTargetSchema, dmTargetSchema]);
export type EngagementTarget = z.infer<typeof engagementTargetSchema>;

export const engagementPhaseSchema = z.enum(["reserved", "starting", "polling", "provider_succeeded", "complete"]);
export const engagementProviderOutcomeSchema = z.enum(["followed", "requested", "already_following"]);
export type EngagementProviderOutcome = z.infer<typeof engagementProviderOutcomeSchema>;
export const engagementRecordSchema = z.object({ version: z.literal(1), target: engagementTargetSchema, phase: engagementPhaseSchema,
  providerOutcome: engagementProviderOutcomeSchema.optional() });
export type EngagementRecord = z.infer<typeof engagementRecordSchema>;
export type EngagementObservation = { state: "running" | "success" | "failed" | "unknown" | "requested" | "already_following" |
  "authentication" | "blocked" | "rate_limited"; costUsd?: number; messageId?: string };
export interface EngagementProvider {
  start(target: EngagementTarget): Promise<string>;
  observe(runId: string, target: EngagementTarget): Promise<EngagementObservation>;
}

export const engagementRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("follow"), contactId: base.shape.contactId, username: instagramUsername }).strict(),
  z.object({ action: z.enum(["comment_1", "comment_2", "comment_3"]), contactId: base.shape.contactId,
    username: instagramUsername, postUrl: postUrlSchema, text: commentTargetSchema.shape.text }).strict(),
  z.object({ action: z.literal("dm"), contactId: base.shape.contactId, username: instagramUsername,
    text: dmTargetSchema.shape.text, approvalBatchId: z.uuid() }).strict(),
]);

export function switchFor(action: EngagementAction): "follow" | "comment" | "dm" {
  return action === "follow" ? "follow" : action === "dm" ? "dm" : "comment";
}
export function successTag(action: EngagementAction) {
  return ({ follow: "ig-followed", comment_1: "ig-comment-1", comment_2: "ig-comment-2",
    comment_3: "ig-comment-3", dm: "ig-dm-sent" } as const)[action];
}
export function sameEngagementTarget(a: EngagementTarget, b: EngagementTarget) {
  return JSON.stringify(a) === JSON.stringify(b);
}
