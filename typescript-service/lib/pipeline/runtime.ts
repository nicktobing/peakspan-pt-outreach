import { z } from "zod";
import { GhlClient } from "../clients/ghl";
import { ProviderError } from "../clients/errors";
import { getDb } from "../db/client";
import { PipelineBackfillRepository } from "../db/pipeline-backfill";
import { directoryRecords } from "../leads/runtime";
import { createPipelinePlan, type PipelineCreationPlan } from "./backfill-contracts";
import { buildPipelineReconciliationPreview, PT_AFFILIATE_PIPELINE } from "./reconciliation";

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
type BackfillLedger = Pick<PipelineBackfillRepository, "claim" | "find" | "progress" | "beginContact" | "canCreate" | "record" | "stop" | "complete">;
type BackfillDependencies = {
  previewPlan(): Promise<PipelineCreationPlan | null>;
  ledger: BackfillLedger;
  list(contactId: string, pipelineId: string): Promise<Opportunity[]>;
  get(opportunityId: string): Promise<Opportunity>;
  create(planId: string, input: OpportunityInput): Promise<Opportunity>;
};

function productionBackfillDependencies(): BackfillDependencies {
  const token = required("GHL_API_TOKEN"); const locationId = required("GHL_LOCATION_ID");
  const reader = new GhlClient(token, locationId); const ledger = new PipelineBackfillRepository(getDb());
  let pending: { planId: string; input: OpportunityInput } | undefined;
  const list = (contactId: string, pipelineId: string) => reader.listOpportunities({ contactId, pipelineId, status: "all" });
  const writer = new GhlClient(token, locationId, { authorizeWrite: async () => pending !== undefined &&
    await ledger.canCreate(pending.planId, pending.input.contactId) &&
    (await list(pending.input.contactId, pending.input.pipelineId)).length === 0 });
  return { previewPlan: async () => (await readPipelineReconciliation()).plan, ledger, list,
    get: (opportunityId) => reader.getOpportunity(opportunityId),
    create: async (planId, input) => { pending = { planId, input };
      try { return await writer.createOpportunity(input); } finally { pending = undefined; } } };
}

function exactOpportunity(value: Opportunity, plan: PipelineCreationPlan, item: PipelineCreationPlan["items"][number]) {
  return value.contactId === item.contactId && value.pipelineId === plan.pipelineId && value.pipelineStageId === item.stageId &&
    value.locationId === plan.locationId && value.name === item.opportunityName && value.status === "open";
}

export async function createApprovedPipelineOpportunities(raw: PipelineCreationApproval, deps = productionBackfillDependencies()) {
  const approval = pipelineCreationApprovalSchema.parse(raw); const existing = await deps.ledger.find(approval.planId);
  if (existing) return { mode: "create_only" as const, status: "already_claimed" as const,
    reason: "single_use_plan" as const, created: existing.outcomes, progress: existing };
  const plan = await deps.previewPlan();
  if (!plan || plan.id !== approval.planId) return { mode: "create_only" as const, status: "blocked" as const,
    reason: "preview_changed" as const, created: [] as PipelineLedgerOutcome[] };
  const claim = await deps.ledger.claim(plan);
  if (!claim.acquired) return { mode: "create_only" as const, status: "already_claimed" as const,
    reason: "single_use_plan" as const, created: claim.progress.outcomes, progress: claim.progress };
  let created: PipelineLedgerOutcome[] = [];
  const stop = async (contactId: string, reason: "precondition_changed" | "provider_unknown" | "provider_rejected" | "read_failed") => {
    try { const progress = await deps.ledger.stop(plan.id, contactId, reason); created = progress.outcomes;
      return { mode: "create_only" as const, status: "stopped" as const, reason, created, uncertainContactId: contactId }; }
    catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
      created, uncertainContactId: contactId }; }
  };
  for (const item of plan.items) {
    try { if (!(await deps.ledger.beginContact(plan.id, item.contactId))) return stop(item.contactId, "precondition_changed"); }
    catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
      created, uncertainContactId: item.contactId }; }
    let existing: Opportunity[];
    try { existing = await deps.list(item.contactId, plan.pipelineId); }
    catch { return stop(item.contactId, "read_failed"); }
    if (existing.length !== 0) return stop(item.contactId, "precondition_changed");
    const input = { pipelineId: plan.pipelineId, pipelineStageId: item.stageId, contactId: item.contactId, name: item.opportunityName };
    let response: Opportunity;
    try {
      response = await deps.create(plan.id, input);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== "unknown_outcome") return stop(item.contactId, "provider_rejected");
      let matches: Opportunity[];
      try { matches = (await deps.list(item.contactId, plan.pipelineId)).filter((value) => exactOpportunity(value, plan, item)); }
      catch { return stop(item.contactId, "read_failed"); }
      if (matches.length !== 1) return stop(item.contactId, "provider_unknown");
      const outcome = { contactId: item.contactId, opportunityId: matches[0].id, evidence: "reconciled" as const };
      try { await deps.ledger.record(plan.id, outcome); created = (await deps.ledger.progress(plan.id)).outcomes; }
      catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
        created: [...created, outcome], uncertainContactId: item.contactId }; }
      continue;
    }
    let verified: Opportunity;
    try { verified = await deps.get(response.id); }
    catch { return stop(item.contactId, "read_failed"); }
    if (verified.id !== response.id || !exactOpportunity(verified, plan, item)) return stop(item.contactId, "provider_unknown");
    const outcome = { contactId: item.contactId, opportunityId: verified.id, evidence: "response" as const };
    try { await deps.ledger.record(plan.id, outcome); created = (await deps.ledger.progress(plan.id)).outcomes; }
    catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const,
      created: [...created, outcome], uncertainContactId: item.contactId }; }
  }
  try { const progress = await deps.ledger.complete(plan.id);
    return { mode: "create_only" as const, status: "complete" as const, created: progress.outcomes }; }
  catch { return { mode: "create_only" as const, status: "stopped" as const, reason: "ledger_write_failed" as const, created }; }
}
type PipelineLedgerOutcome = { contactId: string; opportunityId: string; evidence: "response" | "reconciled" };
