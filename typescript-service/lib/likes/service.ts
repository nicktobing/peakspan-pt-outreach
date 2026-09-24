import { ProviderError } from "../clients/errors";
import { LikeRepository } from "../db/likes";
import type { LikeProvider, LikeTarget } from "./contracts";

export type LikeDependencies = {
  repository: LikeRepository; provider: LikeProvider;
  // Also repeated by the production provider's authorizeWrite callback before every HTTP attempt.
  canStart(target: LikeTarget): Promise<boolean>;
  canReconcile(target: LikeTarget): Promise<boolean>;
  addSuccessTag(target: LikeTarget): Promise<void>;
};

export async function dispatchLike(repository: LikeRepository, target: LikeTarget, start: (id: string) => Promise<string>) {
  const claim = await repository.claim(target);
  if (!claim.acquired) return { status: "duplicate" as const, request: await repository.progress(claim.id) };
  try {
    const workflowId = await start(claim.id);
    await repository.linkWorkflow(claim.id, workflowId);
    return { status: "accepted" as const, request: await repository.progress(claim.id) };
  } catch {
    // A lost response can follow a successful dispatch. Preserve the account/post claim forever.
    await repository.pause(claim.id, "dispatch_unknown", ["reserved"]);
    return { status: "dispatch_unknown" as const, request: await repository.progress(claim.id) };
  }
}

export async function beginLike(id: string, deps: LikeDependencies) {
  const { repository, provider } = deps;
  const row = await repository.read(id);
  if (row.status !== "running" || row.data.phase !== "reserved") return repository.progress(id);
  if (!(await deps.canStart(row.data.target))) {
    await repository.pause(id, "not_authorized", ["reserved"]); return repository.progress(id);
  }
  if (!(await repository.beginStart(id))) return repository.progress(id);
  try {
    const providerRunId = await provider.start(row.data.target);
    await repository.recordStart(id, providerRunId);
  } catch (error) {
    const auth = error instanceof ProviderError && error.kind === "authentication";
    const denied = error instanceof ProviderError && error.kind === "disabled";
    await repository.pause(id, auth ? "authentication" : denied ? "not_authorized" : "start_unknown", ["starting"], { tripCircuit: auth });
  }
  return repository.progress(id);
}

// Observation never starts an actor, including after timeouts or unknown outcomes.
export async function observeLike(id: string, deps: LikeDependencies) {
  const { repository, provider } = deps;
  const row = await repository.read(id);
  if (row.data.phase !== "polling" || !row.providerRunId) return repository.progress(id);
  const observed = await provider.observe(row.providerRunId, row.data.target);
  if (observed.state === "running") return { ...(await repository.progress(id)), state: "polling" as const };
  if (observed.state === "success") await repository.providerSuccess(id, observed.costUsd);
  else {
    const blocked = ["auth_error", "blocked", "rate_limited"].includes(observed.state);
    await repository.pause(id, observed.state === "unknown" ? "provider_unknown" : observed.state, ["polling"], {
      tripCircuit: blocked, costUsd: observed.costUsd,
      ...(observed.state === "unknown" ? {} : { providerStatus: observed.state }),
    });
  }
  return repository.progress(id);
}

export async function reconcileLike(id: string, deps: LikeDependencies) {
  const row = await deps.repository.read(id);
  if (row.data.phase !== "provider_succeeded") return deps.repository.progress(id);
  if (!(await deps.canReconcile(row.data.target))) {
    await deps.repository.pause(id, "reconciliation_disabled", ["provider_succeeded"]);
    return deps.repository.progress(id);
  }
  // Additive tags are idempotent. Failures leave provider success intact; retries never re-like.
  await deps.addSuccessTag(row.data.target);
  await deps.repository.complete(id);
  return deps.repository.progress(id);
}

