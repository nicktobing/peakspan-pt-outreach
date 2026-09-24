import { z } from "zod";
import { GhlClient } from "../clients/ghl";
import { ApifyClient } from "../clients/apify";
import { getDb } from "../db/client";
import { LikeBatchRepository } from "../db/like-batches";
import { LikeRepository } from "../db/likes";
import { ExecutionRepository } from "../db/repositories";
import { getLikeTarget, likeEnvironmentAllowsWrites } from "../config/likes";
import { getActionSwitch } from "../db/settings";
import { batchConfig, batchEligible, batchPostSchema, contactUsername, selectPost, type BatchState } from "./batch-contracts";
import { executeLikeStage } from "./runtime";
import { directoryContactAllowed, directoryEnabled, directoryRecords } from "../leads/runtime";

const ghl = () => new GhlClient(process.env.GHL_API_TOKEN ?? "", process.env.GHL_LOCATION_ID ?? "");
const repo = () => new LikeBatchRepository(getDb());
export async function batchProfileFields() { return ghl().listCustomFields(); }
export async function batchCandidates() {
  const client = ghl();
  if (process.env.IG_BATCH_SOURCE === "directory") {
    if (!directoryEnabled()) throw new Error("Directory launch disabled");
    const contacts = await client.listContacts(); const records = await directoryRecords();
    const limits = batchConfig(); const account = getLikeTarget();
    const selected: { contactId: string; username: string }[] = []; const seen = new Set<string>(); let skipped = 0;
    for (const record of records) {
      const contact = contacts.find((c) => c.id === record.contactId);
      if (!contact || !batchEligible(contact, await new ExecutionRepository(getDb()).isSuppressed(contact.id), "directory") ||
        seen.has(record.username) || record.username === account.accountUsername || await repo().noPostCount(account.accountId, contact.id) >= 3) { skipped++; continue; }
      selected.push({ contactId: contact.id, username: record.username }); seen.add(record.username);
      if (selected.length >= Math.min(limits.IG_SESSION_PROFILE_LIMIT, limits.IG_SESSION_ACTION_LIMIT)) break;
    }
    return { source: "directory" as const, fieldId: "directory-ledger", selected, skipped, limits };
  }
  const fields = await client.listCustomFields();
  const matches = fields.filter((field) => field.fieldKey === "contact.profile_url" || field.fieldKey === "profile_url");
  const fieldId = process.env.GHL_IG_PROFILE_FIELD_ID || (matches.length === 1 ? matches[0].id : undefined);
  if (!fieldId || !fields.some((field) => field.id === fieldId)) throw new Error("Instagram profile custom field needs configuration");
  const limits = batchConfig(); const account = getLikeTarget();
  const selected: { contactId: string; username: string }[] = []; const seen = new Set<string>();
  let skipped = 0;
  const contacts = (await client.listContacts()).sort((a, b) => a.id.localeCompare(b.id));
  for (const contact of contacts) {
    if (!batchEligible(contact)) { skipped++; continue; }
    const username = contactUsername(contact, fieldId);
    if (!username || username === account.accountUsername || seen.has(username) ||
      await new ExecutionRepository(getDb()).isSuppressed(contact.id) || await repo().noPostCount(account.accountId, contact.id) >= 3) { skipped++; continue; }
    seen.add(username); selected.push({ contactId: contact.id, username });
    if (selected.length >= Math.min(limits.IG_SESSION_PROFILE_LIMIT, limits.IG_SESSION_ACTION_LIMIT)) break;
  }
  return { source: "ghl" as const, fieldId, selected, skipped, limits };
}
export function batchEnabled(mode: "preview" | "execute") {
  if (process.env.VERCEL_ENV !== "production" || process.env.IG_BATCH_DISCOVERY_ENABLED !== "true") return false;
  return mode === "preview" || process.env.IG_BATCH_ENABLED === "true" && likeEnvironmentAllowsWrites();
}
export async function prepareBatch(requestId: string, mode: "preview" | "execute") {
  if (!batchEnabled(mode)) throw new Error("Batch mode is disabled");
  if (mode === "execute" && (await getActionSwitch("like"))?.disabled !== false) throw new Error("Like switch is disabled");
  const candidates = await batchCandidates(); const account = getLikeTarget();
  const state: BatchState = { version: 1, source: candidates.source, accountId: account.accountId, accountUsername: account.accountUsername,
    mode, profileFieldId: candidates.fieldId, limits: candidates.limits, cursor: 0, nextAt: new Date().toISOString(),
    items: candidates.selected.map((value) => ({ ...value, phase: "queued", polls: 0 })) };
  return repo().create(requestId, state);
}

export type BatchTick = { state: "waiting"; until: string } | { state: "running" | "paused" | "succeeded" | "cancelled" };
export async function tickBatch(id: string): Promise<BatchTick> {
  const repository = repo(); const row = await repository.read(id); const state = row.state;
  if (row.status !== "running") return { state: row.status === "succeeded" ? "succeeded" : row.status === "cancelled" ? "cancelled" : "paused" };
  const pause = async (reason: string): Promise<BatchTick> => { await repository.pause(id, reason); return { state: "paused" }; };
  if (!batchEnabled(state.mode)) return pause("configuration_disabled");
  if (state.mode === "execute" && (await getActionSwitch("like"))?.disabled !== false) return pause("account_circuit_open");
  if (state.cursor >= state.items.length) { await repository.change(id, () => {}, "succeeded"); return { state: "succeeded" }; }
  if (Date.now() < Date.parse(state.nextAt)) return { state: "waiting", until: state.nextAt };
  const index = state.cursor; const item = state.items[index];
  const update = async (apply: (value: typeof item, data: BatchState) => void) => repository.change(id, (data) => {
    if (data.cursor !== index || data.items[index].phase !== item.phase) return;
    apply(data.items[index], data);
  });
  if (item.phase === "succeeded" || item.phase === "skipped") {
    await update((_value, data) => { data.cursor++; data.nextAt = new Date(Date.now() + data.limits.IG_ACTION_DELAY_SECONDS * 1000).toISOString(); });
    return { state: "running" };
  }
  if (item.phase === "queued" || item.phase === "ready") {
    const contact = await ghl().getContact(item.contactId);
    const suppressed = await new ExecutionRepository(getDb()).isSuppressed(item.contactId);
    const identityAllowed = state.source === "directory" ? await directoryContactAllowed(item.contactId, item.username) : contactUsername(contact, state.profileFieldId) === item.username;
    if (!batchEligible(contact, suppressed, state.source) || !identityAllowed) {
      await update((value) => { value.phase = "skipped"; value.reason = "eligibility_changed"; }); return { state: "running" };
    }
  }
  if (item.phase === "queued") {
    // Claim before the non-idempotent paid scraper start. A replay never starts it twice.
    let claimed = false;
    await repository.change(id, (data) => { if (data.cursor === index && data.items[index].phase === "queued") { data.items[index].phase = "scrape_starting"; claimed = true; } });
    if (!claimed) return { state: "running" };
    const client = new ApifyClient(process.env.APIFY_API_TOKEN ?? "", { authorizeWrite: async () => {
      const fresh = await repository.read(id);
      return batchEnabled(fresh.state.mode) && fresh.status === "running" && fresh.state.cursor === index && fresh.state.items[index].phase === "scrape_starting";
    } });
    try {
      const run = await client.startActor("apify/instagram-post-scraper", { username: [item.username], resultsLimit: 10,
        skipPinnedPosts: true, onlyPostsNewerThan: "30 days", dataDetailLevel: "basicData" });
      await repository.recordScrapeStart(id, index, run.id);
    } catch { return pause("scrape_start_unknown"); }
    return { state: "running" };
  }
  if (item.phase === "scrape_starting") return pause("scrape_start_unknown");
  if (item.phase === "scrape_polling") {
    if (!item.scrapeRunId) return pause("missing_scrape_reference");
    const client = new ApifyClient(process.env.APIFY_API_TOKEN ?? ""); const run = await client.getRun(item.scrapeRunId);
    if (run.id !== item.scrapeRunId) return pause("scrape_reference_mismatch");
    if (["READY", "RUNNING", "TIMING-OUT", "ABORTING"].includes(run.status)) {
      if (item.polls >= 40) return pause("scrape_timeout");
      const until = new Date(Date.now() + 15000).toISOString();
      await update((value, data) => { value.polls++; data.nextAt = until; }); return { state: "waiting", until };
    }
    if (run.status !== "SUCCEEDED" || !run.defaultDatasetId) return pause("scrape_failed");
    const rows = await client.readDatasetHead(run.defaultDatasetId, z.unknown(), 11);
    if (rows.length > 10) return pause("scrape_result_limit");
    const validRows = rows.filter((value) => batchPostSchema.safeParse(value).success);
    // An error-only or wholly malformed dataset is not evidence that the profile has no posts.
    if (rows.length > 0 && validRows.length === 0) return pause("scrape_invalid_result");
    const used = new Set(state.items.flatMap((entry) => entry.postUrl ? [entry.postUrl] : []));
    const post = selectPost(validRows, item.username, new Date(), used);
    if (!post) {
      if (state.mode === "preview") await update((value) => { value.phase = "skipped"; value.reason = "preview_no_recent_post"; });
      else await repository.recordNoPost(id, index);
      return { state: "running" };
    }
    await update((value) => { value.postUrl = post.url; value.phase = "ready"; value.polls = 0; });
    return { state: "running" };
  }
  if (item.phase === "ready") {
    if (state.mode === "preview") { await update((value) => { value.phase = "succeeded"; value.reason = "preview_only"; }); return { state: "running" }; }
    if (!item.postUrl) return pause("missing_selected_post");
    const claim = await new LikeRepository(getDb()).claim({ accountId: state.accountId, accountUsername: state.accountUsername,
      contactId: item.contactId, targetUsername: item.username, postUrl: item.postUrl }, { sessionId: id });
    if ("duplicatePost" in claim && claim.duplicatePost) {
      await update((value) => { value.phase = "skipped"; value.reason = "post_already_reserved"; }); return { state: "running" };
    }
    const action = await new LikeRepository(getDb()).read(claim.id);
    if (action.data.sessionId !== id) { await update((value) => { value.phase = "skipped"; value.reason = "post_already_reserved"; }); return { state: "running" }; }
    await update((value) => { value.actionId = claim.id; value.phase = "like_active"; }); return { state: "running" };
  }
  if (item.phase === "like_active") {
    if (!item.actionId) return pause("missing_action_reference");
    const action = await new LikeRepository(getDb()).read(item.actionId);
    const stage = action.data.phase === "reserved" ? "start" : action.data.phase === "provider_succeeded" ? "reconcile" : "observe";
    const progress = await executeLikeStage(item.actionId, stage);
    if (progress.state === "succeeded") { await update((value) => { value.phase = "succeeded"; }); return { state: "running" }; }
    if (["starting", "reserved", "paused", "disabled"].includes(progress.state)) return pause(progress.reason ?? "action_needs_attention");
    if (item.polls >= 40) return pause("action_observation_timeout");
    const until = new Date(Date.now() + 15000).toISOString();
    await update((value, data) => { value.polls++; data.nextAt = until; }); return { state: "waiting", until };
  }
  return pause("item_needs_attention");
}

