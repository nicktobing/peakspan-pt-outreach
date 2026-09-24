import { z } from "zod";
import { GhlClient } from "../clients/ghl";
import { ProviderError } from "../clients/errors";
import { getDb } from "../db/client";
import { PipelineBackfillRepository } from "../db/pipeline-backfill";
import { directoryRecords } from "../leads/runtime";
import { createPipelinePlan, type PipelineCreationPlan } from "./backfill-contracts";
import { buildPipelineReconciliationPreview, desiredAffiliateStage, PT_AFFILIATE_PIPELINE,
  PT_AFFILIATE_STAGES } from "./reconciliation";

function required(name: "GHL_API_TOKEN" | "GHL_LOCATION_ID") {
  const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value;
}

async function readPipelineReconciliation() {
  const records = (await directoryRecords()).map((row) => ({ importId: row.id, contactId: row.contactId!, username: row.username }));
  const locationId = required("GHL_LOCATION_ID");
  const client = new GhlClient(required("GHL_API_TOKEN"), locationId);
  const pipelines = await client.listPipelines();
  const configuredId = process.env.GHL_PIPELINE_ID;
  const matches = pipelines.filter((pipeline) => pipeline.name === PT_AFFILIATE_PIPELINE && (!configuredId || pipeline.id === configuredId));
  if (matches.length !== 1) return { preview: { mode: "read_only" as const, ready: false, pipeline: null, stages: [],
    counts: { eligible: new Set(records.map((row) => row.contactId)).size, created: 0, moved: 0, skipped: 0, duplicated: 0,
      unresolved: new Set(records.map((row) => row.contactId)).size },
    topologyIssues: [matches.length ? "pipeline_ambiguous" : "pipeline_not_found"], items: [] }, plan: null };
  const pipeline = matches[0];
  const [opportunities, contacts] = await Promise.all([
    client.listOpportunities({ pipelineId: pipeline.id, status: "all" }),
    Promise.all([...new Set(records.map((row) => row.contactId))].map(async (contactId) => {
      try { const contact = await client.getContact(contactId); return { contactId, tags: contact.tags, available: contact.id === contactId }; }
      catch { return { contactId, tags: [], available: false }; }
    })),
  ]);
  const preview = buildPipelineReconciliationPreview({ records, contacts, pipeline, opportunities });
  const exactCreationPlan = preview.ready && preview.counts.eligible === 10 && preview.counts.created === 10 &&
    preview.counts.moved === 0 && preview.counts.skipped === 0 && preview.counts.duplicated === 0 && preview.counts.unresolved === 0;
  const plan = exactCreationPlan ? createPipelinePlan({ version: 1, pipelineId: pipeline.id, locationId,
    items: preview.items.map((item) => {
      const stage = preview.stages.find((value) => value.name === item.desiredStage);
      if (item.decision !== "created" || !stage) throw new Error("Invalid pipeline creation plan");
      return { contactId: item.contactId, username: item.username, opportunityName: `PT Affiliate - @${item.username}`,
        stageId: stage.id, stageName: stage.name };
    }) }) : null;
  return { preview, plan };
}

export async function previewPipelineReconciliation() {
  const { preview, plan } = await readPipelineReconciliation();
  return { ...preview, approval: plan ? { id: plan.id, pipelineId: plan.pipelineId, items: plan.items } : null };
}

export const pipelineCreationApprovalSchema = z.object({
  confirmation: z.literal("create-approved-missing-opportunities"),
  planId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PipelineCreationApproval = z.infer<typeof pipelineCreationApprovalSchema>;
type OpportunityInput = { pipelineId: string; pipelineStageId: string; contactId: string; name: string };
type Opportunity = { id: string; contactId?: string; pipelineId?: string; pipelineStageId?: string;
  locationId?: string; name?: string; status?: string };
type BackfillLedger = Pick<PipelineBackfillRepository, "claim" | "find" | "resume" | "progress" | "beginContact" | "canCreate" |
  "consumeCreateAuthorization" | "releaseRejectedAuthorization" | "markWriteAttempted" | "clearContact" | "record" | "stop" |
  "complete">;
type BackfillDependencies = {
  previewPlan(): Promise<PipelineCreationPlan | null>;
  ledger: BackfillLedger;
  list(contactId: string, pipelineId: string): Promise<Opportunity[]>;
  stage(contactId: string): Promise<string | null>;
  topology(item: PipelineCreationPlan["items"][number], pipelineId: string): Promise<boolean>;
  get(opportunityId: string): Promise<Opportunity>;
  create(planId: string, leaseId: string, input: OpportunityInput): Promise<Opportunity>;
};

function productionBackfillDependencies(): BackfillDependencies {
  const token = required("GHL_API_TOKEN"); const locationId = required("GHL_LOCATION_ID");
  const reader = new GhlClient(token, locationId); const ledger = new PipelineBackfillRepository(getDb());
  let pending: { planId: string; leaseId: string; input: OpportunityInput; stageName: string } | undefined;
  const list = (contactId: string, pipelineId: string) => reader.listOpportunities({ contactId, pipelineId, status: "all" });
  const writer = new GhlClient(token, locationId, { authorizeWrite: async () => pending !== undefined &&
    (await list(pending.input.contactId, pending.input.pipelineId)).length === 0 &&
    desiredAffiliateStage((await reader.getContact(pending.input.contactId)).tags) === pending.stageName &&
    await validTopology(reader, pending.input.pipelineId, pending.input.pipelineStageId, pending.stageName) &&
    await ledger.consumeCreateAuthorization(pending.planId, pending.input.contactId, pending.leaseId) });
  return { previewPlan: async () => (await readPipelineReconciliation()).plan, ledger, list,
    stage: async (contactId) => { try { return desiredAffiliateStage((await reader.getContact(contactId)).tags); } catch { return null; } },
    topology: (item, pipelineId) => validTopology(reader, pipelineId, item.stageId, item.stageName),
    get: (opportunityId) => reader.getOpportunity(opportunityId),
    create: async (planId, leaseId, input) => { const item = (await ledger.progress(planId)).plan.items.find((value) => value.contactId === input.contactId);
      if (!item) throw new Error("Unknown pipeline plan contact"); pending = { planId, leaseId, input, stageName: item.stageName };
      try { return await writer.createOpportunity(input); } finally { pending = undefined; } } };
}

async function validTopology(client: GhlClient, pipelineId: string, stageId: string, stageName: string) {
  const matches = (await client.listPipelines()).filter((pipeline) => pipeline.id === pipelineId && pipeline.name === PT_AFFILIATE_PIPELINE);
  if (matches.length !== 1) return false; const pipeline = matches[0];
  return pipeline.stages.length === PT_AFFILIATE_STAGES.length &&
    pipeline.stages.every((stage, index) => stage.name === PT_AFFILIATE_STAGES[index]) &&
    pipeline.stages.some((stage) => stage.id === stageId && stage.name === stageName);
}

function exactOpportunity(value: Opportunity, plan: PipelineCreationPlan, item: PipelineCreationPlan["items"][number]) {
  return value.contactId === item.contactId && value.pipelineId === plan.pipelineId && value.pipelineStageId === item.stageId &&
    value.locationId === plan.locationId && value.name === item.opportunityName && value.status === "open";
}

export async function createApprovedPipelineOpportunities(raw: PipelineCreationApproval, deps = productionBackfillDependencies()) {
  const approval = pipelineCreationApprovalSchema.parse(raw); const existing = await deps.ledger.find(approval.planId);
  let plan: PipelineCreationPlan; let progress = existing;
  if (existing) {
    if (existing.state === "succeeded") return { mode: "create_only" as const, status: "already_claimed" as const,
      reason: "single_use_plan" as const, created: existing.outcomes, progress: existing };
    const resumed = await deps.ledger.resume(approval.planId, new Date(Date.now() - 5 * 60_000));
    if (!resumed.acquired) return { mode: "create_only" as const, status: "already_claimed" as const,
      reason: "run_active" as const, created: resumed.progress.outcomes, progress: resumed.progress };
    plan = resumed.progress.plan; progress = resumed.progress;
  } else {
    const fresh = await deps.previewPlan();
    if (!fresh || fresh.id !== approval.planId) return { mode: "create_only" as const, status: "blocked" as const,
      reason: "preview_changed" as const, created: [] as PipelineLedgerOutcome[] };
    plan = fresh; const claim = await deps.ledger.claim(plan); progress = claim.progress;
    if (!claim.acquired) return { mode: "create_only" as const, status: "already_claimed" as const,
      reason: "single_use_plan" as const, created: claim.progress.outcomes, progress: claim.progress };
  }
  const leaseId = progress.leaseId; let created: PipelineLedgerOutcome[] = progress.outcomes;
  const stop = async (contactId: string, reason: "precondition_changed" | "provider_unknown" | "provider_rejected" | "read_failed") => {
    try { const progress = await deps.ledger.stop(plan.id, contactId, reason, leaseId); created = progress.outcomes;
      return { mode: "create_only" as const, status: "stopped" as const, reason, created, uncertainContactId: contactId }; }
    catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
      created, uncertainContactId: contactId }; }
  };
  const uncertainContactId = progress.currentContactId ?? progress.uncertainContactId;
  if (uncertainContactId && !created.some((outcome) => outcome.contactId === uncertainContactId)) {
    const item = plan.items.find((value) => value.contactId === uncertainContactId);
    if (!item) return stop(uncertainContactId, "precondition_changed");
    if (progress.authorizationConsumedContactId === item.contactId) {
      const settled = progress.uncertainSince && Date.parse(progress.uncertainSince) <= Date.now() - 5 * 60_000;
      if (!settled) return stop(item.contactId, "provider_unknown");
      let opportunities: Opportunity[];
      try { opportunities = await deps.list(item.contactId, plan.pipelineId); } catch { return stop(item.contactId, "read_failed"); }
      if (opportunities.length === 1 && exactOpportunity(opportunities[0], plan, item)) {
        const outcome = { contactId: item.contactId, opportunityId: opportunities[0].id, evidence: "reconciled" as const };
        try { await deps.ledger.record(plan.id, outcome, leaseId); created = (await deps.ledger.progress(plan.id)).outcomes; }
        catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
          created: [...created, outcome], uncertainContactId: item.contactId }; }
      } else return stop(item.contactId, "provider_unknown");
    } else if (!(await deps.ledger.clearContact(plan.id, item.contactId, leaseId))) return stop(item.contactId, "precondition_changed");
  }
  for (const item of plan.items) {
    if (created.some((outcome) => outcome.contactId === item.contactId)) continue;
    try { if (!(await deps.ledger.beginContact(plan.id, item.contactId, leaseId))) return stop(item.contactId, "precondition_changed"); }
    catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
      created, uncertainContactId: item.contactId }; }
    let existing: Opportunity[];
    try { existing = await deps.list(item.contactId, plan.pipelineId); }
    catch { return stop(item.contactId, "read_failed"); }
    if (existing.length !== 0) return stop(item.contactId, "precondition_changed");
    let stage: string | null;
    try { stage = await deps.stage(item.contactId); } catch { return stop(item.contactId, "read_failed"); }
    if (stage !== item.stageName) return stop(item.contactId, "precondition_changed");
    let topology: boolean;
    try { topology = await deps.topology(item, plan.pipelineId); } catch { return stop(item.contactId, "read_failed"); }
    if (!topology) return stop(item.contactId, "precondition_changed");
    try { if (!(await deps.ledger.markWriteAttempted(plan.id, item.contactId, leaseId))) return stop(item.contactId, "precondition_changed"); }
    catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
      created, uncertainContactId: item.contactId }; }
    const input = { pipelineId: plan.pipelineId, pipelineStageId: item.stageId, contactId: item.contactId, name: item.opportunityName };
    let response: Opportunity;
    try {
      response = await deps.create(plan.id, leaseId, input);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "unknown_outcome") return stop(item.contactId, "provider_unknown");
      try {
        if (!(await deps.ledger.releaseRejectedAuthorization(plan.id, item.contactId, leaseId))) {
          return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
            created, uncertainContactId: item.contactId };
        }
      } catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
        created, uncertainContactId: item.contactId }; }
      return stop(item.contactId, "provider_rejected");
    }
    let verified: Opportunity;
    try { verified = await deps.get(response.id); }
    catch { return stop(item.contactId, "read_failed"); }
    if (verified.id !== response.id || !exactOpportunity(verified, plan, item)) return stop(item.contactId, "provider_unknown");
    let all: Opportunity[];
    try { all = await deps.list(item.contactId, plan.pipelineId); } catch { return stop(item.contactId, "read_failed"); }
    if (all.length !== 1 || all[0].id !== response.id || !exactOpportunity(all[0], plan, item)) {
      return stop(item.contactId, "provider_unknown");
    }
    const outcome = { contactId: item.contactId, opportunityId: verified.id, evidence: "response" as const };
    try { await deps.ledger.record(plan.id, outcome, leaseId); created = (await deps.ledger.progress(plan.id)).outcomes; }
    catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
      created: [...created, outcome], uncertainContactId: item.contactId }; }
  }
  try { const progress = await deps.ledger.complete(plan.id, leaseId);
    return { mode: "create_only" as const, status: "complete" as const, created: progress.outcomes }; }
  catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const, created }; }
}
type PipelineLedgerOutcome = { contactId: string; opportunityId: string; evidence: "response" | "reconciled" };
