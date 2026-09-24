import { ProviderError } from "../clients/errors";
import { EngagementRepository } from "../db/engagement";
import type { EngagementProvider, EngagementProviderOutcome, EngagementTarget } from "./contracts";

export type EngagementDependencies = { repository: EngagementRepository; provider: EngagementProvider;
  canStart(target: EngagementTarget): Promise<boolean>;
  canReconcile(target: EngagementTarget, outcome?: EngagementProviderOutcome): Promise<boolean>;
  addSuccessTag(target: EngagementTarget, outcome?: EngagementProviderOutcome): Promise<void> };

export async function dispatchEngagement(repository: EngagementRepository, target: EngagementTarget, start: (id: string) => Promise<string>) {
  const claim = await repository.claim(target);
  if (!claim.acquired) return { status: "duplicate" as const, request: await repository.progress(claim.id) };
  try { const workflowId = await start(claim.id); await repository.linkWorkflow(claim.id, workflowId);
    return { status: "accepted" as const, request: await repository.progress(claim.id) };
  } catch { await repository.pause(claim.id, "dispatch_unknown", ["reserved"]);
    return { status: "dispatch_unknown" as const, request: await repository.progress(claim.id) }; }
}
export async function beginEngagement(id: string, deps: EngagementDependencies) {
  const row = await deps.repository.read(id);
  if (row.status !== "running" || row.data.phase !== "reserved") return deps.repository.progress(id);
  if (!(await deps.canStart(row.data.target))) { await deps.repository.pause(id, "not_authorized", ["reserved"]); return deps.repository.progress(id); }
  if (!(await deps.repository.beginStart(id))) return deps.repository.progress(id);
  try { await deps.repository.recordStart(id, await deps.provider.start(row.data.target)); }
  catch (error) { const auth = error instanceof ProviderError && error.kind === "authentication";
    const denied = error instanceof ProviderError && error.kind === "disabled";
    await deps.repository.pause(id, auth ? "authentication" : denied ? "not_authorized" : "start_unknown", ["starting"], { tripCircuit: auth }); }
  return deps.repository.progress(id);
}
export async function observeEngagement(id: string, deps: EngagementDependencies) {
  const row = await deps.repository.read(id);
  if (row.data.phase !== "polling" || !row.providerRunId) return deps.repository.progress(id);
  const observed = await deps.provider.observe(row.providerRunId, row.data.target);
  if (observed.state === "running") return deps.repository.progress(id);
  if (["success", "requested", "already_following"].includes(observed.state)) {
    const outcome = observed.state === "success" ? (row.data.target.action === "follow" ? "followed" : undefined)
      : observed.state as "requested" | "already_following";
    await deps.repository.providerSuccess(id, observed.costUsd, observed.messageId, outcome);
  } else if (observed.state === "failed") await deps.repository.providerFailure(id, observed.costUsd);
  else await deps.repository.pause(id, observed.state === "unknown" ? "provider_unknown" : `provider_${observed.state}`, ["polling"],
    { tripCircuit: ["authentication", "blocked", "rate_limited"].includes(observed.state), costUsd: observed.costUsd });
  return deps.repository.progress(id);
}
export async function reconcileEngagement(id: string, deps: EngagementDependencies) {
  const row = await deps.repository.read(id);
  if (row.data.phase !== "provider_succeeded") return deps.repository.progress(id);
  const outcome = row.data.providerOutcome;
  if (row.data.target.action === "follow" && !outcome) {
    await deps.repository.pause(id, "provider_unknown", ["provider_succeeded"]);
    return deps.repository.progress(id);
  }
  if (!(await deps.canReconcile(row.data.target, outcome))) { await deps.repository.pause(id, "reconciliation_disabled", ["provider_succeeded"]); return deps.repository.progress(id); }
  // A private-account follow request is accepted by the provider but is not yet a follow.
  // Completing it without ig-followed keeps downstream comment prerequisites closed.
  if (outcome !== "requested") await deps.addSuccessTag(row.data.target, outcome);
  await deps.repository.complete(id); return deps.repository.progress(id);
}
