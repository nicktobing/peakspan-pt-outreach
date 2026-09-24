import { z } from "zod";
import { normalizeInstagramUsername } from "../domain/normalization";
import { isSuppressed } from "../domain/eligibility";
import { instagramUsername, likeTargetSchema, postUrlSchema } from "./contracts";

export const batchConfigSchema = z.object({
  IG_SESSION_PROFILE_LIMIT: z.coerce.number().int().min(1).max(29).default(10),
  IG_SESSION_ACTION_LIMIT: z.coerce.number().int().min(1).max(29).default(10),
  IG_ROLLING_DAY_ACTION_LIMIT: z.coerce.number().int().min(1).max(29).default(29),
  IG_ACTION_DELAY_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
});
export function batchConfig(env = process.env) {
  const result = batchConfigSchema.safeParse(env);
  if (!result.success) throw new Error("Invalid Instagram activity limits");
  return result.data;
}
export const batchItemSchema = z.object({
  contactId: likeTargetSchema.shape.contactId, username: instagramUsername,
  phase: z.enum(["queued", "scrape_starting", "scrape_polling", "ready", "like_active", "succeeded", "skipped", "paused"]),
  scrapeRunId: z.string().optional(), actionId: z.uuid().optional(), postUrl: postUrlSchema.optional(),
  reason: z.string().regex(/^[a-z_]+$/).optional(), polls: z.number().int().nonnegative().default(0),
});
export const batchStateSchema = z.object({
  source: z.enum(["ghl", "directory"]).optional(),
  version: z.literal(1), accountId: likeTargetSchema.shape.accountId, accountUsername: instagramUsername,
  mode: z.enum(["preview", "execute"]), profileFieldId: z.string().min(1),
  items: z.array(batchItemSchema).max(29), cursor: z.number().int().min(0).max(29),
  limits: batchConfigSchema, nextAt: z.iso.datetime(), reason: z.string().optional(),
  attentionAt: z.iso.datetime().optional(),
});
export type BatchState = z.infer<typeof batchStateSchema>;
export type BatchItem = z.infer<typeof batchItemSchema>;
export type BatchContact = { id: string; tags: string[]; customFields: { id: string; value?: unknown; fieldValue?: unknown }[] };
export function contactUsername(contact: BatchContact, fieldId: string) {
  const field = contact.customFields.find((value) => value.id === fieldId);
  const value = field?.value ?? field?.fieldValue;
  return typeof value === "string" ? normalizeInstagramUsername(value) : null;
}
export function batchEligible(contact: BatchContact, suppressed = false, source: "ghl" | "directory" = "ghl") {
  const tags = new Set(contact.tags.map((value) => value.trim().toLowerCase()));
  const qualified = source === "directory" ? tags.has("peakspan-directory-qualified") : tags.has("qualified") && tags.has("ig-followed");
  return qualified && !tags.has("ig-liked") && !isSuppressed(contact.tags, suppressed);
}

export const batchPostSchema = z.object({ url: postUrlSchema, ownerUsername: z.string(), timestamp: z.iso.datetime({ offset: true }),
  coauthorProducers: z.array(z.object({ username: z.string() })).nullish() });
export function selectPost(rows: unknown[], username: string, now: Date, used: Set<string> = new Set()) {
  const valid = rows.flatMap((row) => { const parsed = batchPostSchema.safeParse(row); return parsed.success ? [parsed.data] : []; })
    .filter((row) => Date.parse(row.timestamp) <= now.getTime() && Date.parse(row.timestamp) >= now.getTime() - 30 * 86400000 && !used.has(row.url))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.url.localeCompare(b.url));
  return valid.find((row) => normalizeInstagramUsername(row.ownerUsername) === username) ??
    valid.find((row) => row.coauthorProducers?.some((author) => normalizeInstagramUsername(author.username) === username)) ?? null;
}

