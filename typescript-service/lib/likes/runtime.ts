import { z } from "zod";
import { ApifyClient } from "../clients/apify";
import { GhlClient } from "../clients/ghl";
import { getLikeCookies, getLikeTarget, likeEnvironmentAllowsWrites } from "../config/likes";
import { getDb } from "../db/client";
import { LikeRepository } from "../db/likes";
import { ExecutionRepository } from "../db/repositories";
import { getActionSwitch } from "../db/settings";
import { isSuppressed } from "../domain/eligibility";
import { ApifyInstagramLikeProvider } from "../providers/instagram-like";
import { sameTarget, type LikeProgress, type LikeTarget } from "./contracts";
import { beginLike, observeLike, reconcileLike, type LikeDependencies } from "./service";
import { LikeBatchRepository } from "../db/like-batches";
import { batchEligible, contactUsername } from "./batch-contracts";
import { directoryContactAllowed } from "../leads/runtime";

function secret(name: string) {
  const parsed = z.string().min(1).safeParse(process.env[name]);
  if (!parsed.success) throw new Error("Missing like provider configuration");
  return parsed.data;
}
export async function likeTargetAllowed(target: LikeTarget, sessionId?: string) {
  if (!likeEnvironmentAllowsWrites()) return false;
  if (sessionId) {
    if (process.env.IG_BATCH_ENABLED !== "true") return false;
    const session = await new LikeBatchRepository(getDb()).read(sessionId);
    const item = session.state.items[session.state.cursor];
    if (session.status !== "running" || session.state.mode !== "execute" || item?.phase !== "like_active" ||
      session.state.accountId !== target.accountId || session.state.accountUsername !== target.accountUsername ||
      target.accountId !== process.env.IG_LIKE_ACCOUNT_ID || target.accountUsername !== process.env.IG_LIKE_ACCOUNT_USERNAME ||
      item.contactId !== target.contactId || item.username !== target.targetUsername || item.postUrl !== target.postUrl) return false;
  } else if (!sameTarget(target, getLikeTarget())) return false;
  const setting = await getActionSwitch("like");
  return setting?.disabled === false;
}
export async function likeReconciliationAllowed(target: LikeTarget, actionId: string, sessionId?: string) {
  if (!sessionId) return likeTargetAllowed(target);
  if (!likeEnvironmentAllowsWrites() || process.env.IG_BATCH_ENABLED !== "true") return false;
  const action = await new LikeRepository(getDb()).read(actionId);
  if (action.data.sessionId !== sessionId || !sameTarget(action.data.target, target) ||
    !action.providerRunId || action.data.phase !== "provider_succeeded") return false;
  const session = await new LikeBatchRepository(getDb()).read(sessionId);
  const item = session.state.items.find((entry) => entry.actionId === actionId);
  if (!["running", "paused", "cancelled"].includes(session.status) || session.state.mode !== "execute" ||
    session.state.accountId !== target.accountId || session.state.accountUsername !== target.accountUsername ||
    target.accountId !== process.env.IG_LIKE_ACCOUNT_ID || target.accountUsername !== process.env.IG_LIKE_ACCOUNT_USERNAME ||
    item?.contactId !== target.contactId || item.username !== target.targetUsername || item.postUrl !== target.postUrl) return false;
  return (await getActionSwitch("like"))?.disabled === false;
}
function ghl(authorizeWrite?: () => Promise<boolean>) {
  return new GhlClient(secret("GHL_API_TOKEN"), secret("GHL_LOCATION_ID"), { authorizeWrite });
}
export async function canStartLike(target: LikeTarget, sessionId?: string) {
  if (!(await likeTargetAllowed(target, sessionId))) return false;
  getLikeCookies(target.accountId);
  const contact = await ghl().getContact(target.contactId);
  if (contact.id !== target.contactId) return false;
  const suppressed = await new ExecutionRepository(getDb()).isSuppressed(target.contactId);
  if (isSuppressed(contact.tags, suppressed)) return false;
  if (sessionId) {
    const session = await new LikeBatchRepository(getDb()).read(sessionId);
    const identityAllowed = session.state.source === "directory" ? await directoryContactAllowed(contact.id, target.targetUsername) : contactUsername(contact, session.state.profileFieldId) === target.targetUsername;
    if (!batchEligible(contact, suppressed, session.state.source) || !identityAllowed) return false;
  } else if (!contact.tags.some((tag) => tag.trim().toLowerCase() === "qualified")) return false;
  return likeTargetAllowed(target, sessionId);
}
async function dependencies(id: string): Promise<LikeDependencies> {
  const repository = new LikeRepository(getDb());
  const row = await repository.read(id);
  const target = row.data.target;
  const sessionId = row.data.sessionId;
  const apify = new ApifyClient(secret("APIFY_API_TOKEN"), { authorizeWrite: async () => {
    const current = await repository.read(id);
    return current.status === "running" && current.data.phase === "starting" && await canStartLike(target, sessionId);
  } });
  return { repository, provider: new ApifyInstagramLikeProvider(apify, () => getLikeCookies(target.accountId)),
    canStart: (input) => canStartLike(input, sessionId),
    canReconcile: async (input) => {
      if (!(await likeReconciliationAllowed(input, id, sessionId))) return false;
      return (await ghl().getContact(input.contactId)).id === input.contactId;
    },
    addSuccessTag: async (input) => { await ghl(() => likeReconciliationAllowed(input, id, sessionId)).addTags(input.contactId, ["ig-liked"]); },
  };
}

export async function executeLikeStage(id: string, stage: "start" | "observe" | "reconcile"): Promise<LikeProgress> {
  // Default-disabled durable executions do not access DB or providers.
  if (process.env.IG_LIKE_ENABLED !== "true") return { state: "disabled" };
  const deps = await dependencies(id);
  if (stage === "start") return beginLike(id, deps);
  if (stage === "observe") return observeLike(id, deps);
  return reconcileLike(id, deps);
}
export async function pauseLikeExecution(id: string, reason: "poll_timeout" | "execution_failed"): Promise<LikeProgress> {
  if (process.env.IG_LIKE_ENABLED !== "true") return { state: "disabled" };
  const repository = new LikeRepository(getDb());
  await repository.pause(id, reason, ["reserved", "starting", "polling", "provider_succeeded"]);
  return repository.progress(id);
}

