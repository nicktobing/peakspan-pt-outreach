import { z } from "zod";
import { normalizeInstagramUsername } from "../domain/normalization";

export const instagramUsername = z.string().transform((value, ctx) => {
  const name = normalizeInstagramUsername(value);
  if (!name) { ctx.addIssue({ code: "custom", message: "Invalid Instagram username" }); return z.NEVER; }
  return name;
});

export function instagramPost(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
    url.port || url.username || url.password) throw new Error("Invalid Instagram post");
  const match = /^\/(p|reel|reels)\/([A-Za-z0-9_-]{1,100})\/?$/.exec(url.pathname);
  if (!match) throw new Error("Invalid Instagram post");
  return { shortcode: match[2], postUrl: `https://www.instagram.com/${match[1] === "p" ? "p" : "reel"}/${match[2]}/` };
}

export const postUrlSchema = z.string().max(1000).transform((value, ctx) => {
  try { return instagramPost(value).postUrl; }
  catch { ctx.addIssue({ code: "custom", message: "Invalid Instagram post" }); return z.NEVER; }
});
export const likeTargetSchema = z.object({
  accountId: z.string().regex(/^[1-9][0-9]{0,29}$/), accountUsername: instagramUsername,
  contactId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), targetUsername: instagramUsername,
  postUrl: postUrlSchema,
});
export type LikeTarget = z.infer<typeof likeTargetSchema>;
export const likeRequestSchema = z.object({ contactId: likeTargetSchema.shape.contactId, postUrl: postUrlSchema }).strict();
export const likePhaseSchema = z.enum(["reserved", "starting", "polling", "provider_succeeded", "complete"]);
export const actorLikeStatus = z.enum(["success", "failed", "blocked", "rate_limited", "auth_error"]);
export const likeRecordSchema = z.object({
  version: z.literal(1), target: likeTargetSchema, phase: likePhaseSchema,
  workflowRunId: z.string().optional(), providerStatus: actorLikeStatus.optional(),
  sessionId: z.uuid().optional(),
});
export type LikeRecord = z.infer<typeof likeRecordSchema>;
export type LikeProgress = { id?: string; state: "disabled" | "reserved" | "starting" | "polling" | "provider_succeeded" | "succeeded" | "paused" | "cancelled";
  providerRunId?: string; providerStatus?: z.infer<typeof actorLikeStatus>; reason?: string; costUsd?: string };
export type LikeObservation = { state: "running" | "success" | "unknown" | "failed" | "blocked" | "rate_limited" | "auth_error"; costUsd?: number };
export interface LikeProvider {
  start(target: LikeTarget): Promise<string>;
  observe(runId: string, target: LikeTarget): Promise<LikeObservation>;
}

export function sameTarget(a: LikeTarget, b: LikeTarget) {
  return a.accountId === b.accountId && a.accountUsername === b.accountUsername && a.contactId === b.contactId &&
    a.targetUsername === b.targetUsername && instagramPost(a.postUrl).shortcode === instagramPost(b.postUrl).shortcode;
}

