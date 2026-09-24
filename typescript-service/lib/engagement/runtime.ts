import { z } from "zod";
import { ApifyClient } from "../clients/apify";
import { GhlClient } from "../clients/ghl";
import { engagementAccount, engagementCookies, engagementEnvironmentAllowsWrites, engagementSessionId } from "../config/engagement";
import { EngagementRepository } from "../db/engagement";
import { DmApprovalRepository } from "../db/dm-approvals";
import { getDb } from "../db/client";
import { getActionSwitch } from "../db/settings";
import { ExecutionRepository } from "../db/repositories";
import { isSuppressed } from "../domain/eligibility";
import { contactUsername } from "../likes/batch-contracts";
import { actionAttempts } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { instagramPost } from "../likes/contracts";
import { directoryContactAllowed } from "../leads/runtime";
import { ApifyInstagramEngagementProvider } from "../providers/instagram-engagement";
import { switchFor, successTag, type EngagementProviderOutcome, type EngagementTarget } from "./contracts";
import { beginEngagement, observeEngagement, reconcileEngagement, type EngagementDependencies } from "./service";

function secret(name: string) { return z.string().min(1).parse(process.env[name]); }
function ghl(authorizeWrite?: () => Promise<boolean>) { return new GhlClient(secret("GHL_API_TOKEN"), secret("GHL_LOCATION_ID"), { authorizeWrite }); }
async function identityAllowed(target: EngagementTarget) {
  if (await directoryContactAllowed(target.contactId, target.targetUsername)) return true;
  const client = ghl(); const contact = await client.getContact(target.contactId); const fields = await client.listCustomFields();
  const ids = fields.filter((field) => /(?:instagram|ig_profile|profile_url)/i.test(field.fieldKey)).map((field) => field.id);
  return ids.some((id) => contactUsername(contact, id) === target.targetUsername);
}
function prerequisite(tags: string[], target: EngagementTarget) {
  const values = new Set(tags.map((tag) => tag.trim().toLowerCase()));
  if (target.action === "follow") return (values.has("qualified") || values.has("peakspan-directory-qualified")) && !values.has("ig-followed");
  if (target.action === "comment_1") return values.has("ig-followed") && !values.has("ig-comment-1");
  if (target.action === "comment_2") return values.has("ig-comment-1") && !values.has("ig-comment-2");
  if (target.action === "comment_3") return values.has("ig-comment-2") && !values.has("ig-comment-3");
  return values.has("ig-comment-3") && !values.has("ig-dm-sent") && !values.has("outreach-sent");
}
async function commentPostAllowed(target: EngagementTarget) {
  if (target.action === "follow" || target.action === "dm") return true;
  const [row] = await getDb().select({ result: actionAttempts.result }).from(actionAttempts).where(and(
    eq(actionAttempts.contactId, target.contactId), eq(actionAttempts.action, "like"), eq(actionAttempts.status, "succeeded"),
    sql`${actionAttempts.result}->'target'->>'accountId' = ${target.accountId}`,
    sql`${actionAttempts.result}->'target'->>'targetUsername' = ${target.targetUsername}`,
    sql`${actionAttempts.result}->'target'->>'postUrl' = ${target.postUrl}`,
  )).limit(1);
  if (!row) return false;
  try { return instagramPost(String((row.result as { target?: { postUrl?: unknown } })?.target?.postUrl)).shortcode === instagramPost(target.postUrl).shortcode; }
  catch { return false; }
}
export async function engagementAllowed(target: EngagementTarget, requireProviderSuccess = false) {
  if (!engagementEnvironmentAllowsWrites(target.action)) return false;
  const account = engagementAccount();
  if (target.accountId !== account.accountId || target.accountUsername !== account.accountUsername) return false;
  if ((await getActionSwitch(switchFor(target.action)))?.disabled !== false) return false;
  if (requireProviderSuccess) return true;
  const contact = await ghl().getContact(target.contactId); const suppressed = await new ExecutionRepository(getDb()).isSuppressed(target.contactId);
  if (contact.id !== target.contactId || isSuppressed(contact.tags, suppressed) || !prerequisite(contact.tags, target) ||
    !(await identityAllowed(target)) || !(await commentPostAllowed(target))) return false;
  if (target.action === "dm" && !(await new DmApprovalRepository(getDb()).allows(target.approvalBatchId,
    { contactId: target.contactId, targetUsername: target.targetUsername, text: target.text }, target.accountId, target.accountUsername))) return false;
  return engagementEnvironmentAllowsWrites(target.action);
}
async function providerSuccessReconciliationAllowed(target: EngagementTarget, outcome?: EngagementProviderOutcome) {
  if (target.action !== "follow") return await engagementAllowed(target, true) && (await ghl().getContact(target.contactId)).id === target.contactId;
  if (!outcome) return false;
  const account = engagementAccount();
  if (target.accountId !== account.accountId || target.accountUsername !== account.accountUsername) return false;
  return (await ghl().getContact(target.contactId)).id === target.contactId && await identityAllowed(target);
}
async function dependencies(id: string): Promise<EngagementDependencies> {
  const repository = new EngagementRepository(getDb()); const row = await repository.read(id); const target = row.data.target;
  const apify = new ApifyClient(secret("APIFY_API_TOKEN"), { authorizeWrite: async () => {
    const current = await repository.read(id);
    return current.status === "running" && current.data.phase === "starting" && await engagementAllowed(target);
  } });
  return { repository, provider: new ApifyInstagramEngagementProvider(apify, () => engagementCookies(target.accountId), () => engagementSessionId(target.accountId)),
    canStart: engagementAllowed,
    canReconcile: providerSuccessReconciliationAllowed,
    addSuccessTag: async (value, outcome) => {
      await ghl(() => providerSuccessReconciliationAllowed(value, outcome)).addTags(value.contactId, [successTag(value.action)]);
    },
  };
}
export async function executeEngagementStageWithDependencies(id: string, stage: "start" | "observe" | "reconcile",
  deps: EngagementDependencies) {
  const row = await deps.repository.read(id);
  // Observation is a read-only recovery of an already-started provider run. It must remain available while launch switches are closed.
  if (stage === "observe") return observeEngagement(id, deps);
  if (stage === "start" && process.env.IG_FOLLOW_ENABLED !== "true" && process.env.IG_COMMENT_ENABLED !== "true" && process.env.IG_DM_ENABLED !== "true") {
    return { state: "disabled" as const };
  }
  if (stage === "start" && !engagementEnvironmentAllowsWrites(row.data.target.action)) return { state: "disabled" as const };
  if (stage === "start") return beginEngagement(id, deps);
  return reconcileEngagement(id, deps);
}
export async function executeEngagementStage(id: string, stage: "start" | "observe" | "reconcile") {
  // Default-disabled deployments still avoid DB/provider access for new actions and CRM writes.
  if (stage === "start" && process.env.IG_FOLLOW_ENABLED !== "true" && process.env.IG_COMMENT_ENABLED !== "true" && process.env.IG_DM_ENABLED !== "true") {
    return { state: "disabled" as const };
  }
  return executeEngagementStageWithDependencies(id, stage, await dependencies(id));
}
export async function pauseEngagement(id: string, reason: "poll_timeout" | "execution_failed") {
  const repository = new EngagementRepository(getDb());
  await repository.pause(id, reason, ["reserved", "starting", "polling", "provider_succeeded"]);
  return repository.progress(id);
}
