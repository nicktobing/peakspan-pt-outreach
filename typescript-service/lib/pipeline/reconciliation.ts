export const PT_AFFILIATE_PIPELINE = "PT Affiliate Pipeline";
export const PT_AFFILIATE_STAGES = ["Identified", "Qualified", "Disqualified", "Comment 1x", "Comment 2x", "Comment 3x",
  "Outreach Sent", "Responded", "Interested", "Affiliate Onboarded"] as const;

export type ReconciliationRecord = { importId: string; contactId: string; username: string };
export type ReconciliationContact = { contactId: string; tags: string[]; available: boolean };
export type ReconciliationOpportunity = { id: string; contactId?: string; pipelineStageId?: string };
export type ReconciliationPipeline = { id: string; name: string; stages: { id: string; name: string }[] };
export type ReconciliationDecision = "created" | "moved" | "skipped" | "duplicated" | "unresolved";

function normalizedTags(tags: string[]) { return new Set(tags.map((tag) => tag.trim().toLowerCase())); }
export function desiredAffiliateStage(tags: string[]) {
  const values = normalizedTags(tags);
  if (values.has("affiliate-onboarded") || values.has("affiliate onboarded")) return "Affiliate Onboarded";
  if (values.has("interested")) return "Interested";
  if (values.has("responded")) return "Responded";
  if (values.has("outreach-sent") || values.has("ig-dm-sent")) return "Outreach Sent";
  if (values.has("ig-comment-3")) return "Comment 3x";
  if (values.has("ig-comment-2")) return "Comment 2x";
  if (values.has("ig-comment-1")) return "Comment 1x";
  if (values.has("disqualified")) return "Disqualified";
  // A successfully completed directory import is qualified by its durable Instagram identity.
  return "Qualified";
}

export function buildPipelineReconciliationPreview(input: { records: ReconciliationRecord[]; contacts: ReconciliationContact[];
  pipeline: ReconciliationPipeline; opportunities: ReconciliationOpportunity[] }) {
  const stageGroups = new Map<string, { id: string; name: string }[]>();
  for (const stage of input.pipeline.stages) stageGroups.set(stage.name, [...(stageGroups.get(stage.name) ?? []), stage]);
  const stageOrderMatches = input.pipeline.stages.length === PT_AFFILIATE_STAGES.length &&
    input.pipeline.stages.every((stage, index) => stage.name === PT_AFFILIATE_STAGES[index]);
  const topologyIssues = [
    ...(input.pipeline.name === PT_AFFILIATE_PIPELINE ? [] : [`pipeline_name:${input.pipeline.name}`]),
    ...PT_AFFILIATE_STAGES.filter((name) => (stageGroups.get(name)?.length ?? 0) !== 1).map((name) => `stage:${name}`),
    ...input.pipeline.stages.filter((stage) => !PT_AFFILIATE_STAGES.includes(stage.name as typeof PT_AFFILIATE_STAGES[number]))
      .map((stage) => `unexpected_stage:${stage.name}`),
    ...(stageOrderMatches ? [] : ["stage_order"]),
  ];
  const stageById = new Map(input.pipeline.stages.map((stage) => [stage.id, stage.name]));
  const contactById = new Map(input.contacts.map((contact) => [contact.contactId, contact]));
  const recordsByContact = new Map<string, ReconciliationRecord[]>();
  const contactsByUsername = new Map<string, Set<string>>();
  for (const record of input.records) {
    recordsByContact.set(record.contactId, [...(recordsByContact.get(record.contactId) ?? []), record]);
    const username = record.username.toLowerCase().replace(/^@/, "");
    const ids = contactsByUsername.get(username) ?? new Set<string>(); ids.add(record.contactId); contactsByUsername.set(username, ids);
  }
  const opportunitiesByContact = new Map<string, ReconciliationOpportunity[]>();
  for (const opportunity of input.opportunities) if (opportunity.contactId) {
    opportunitiesByContact.set(opportunity.contactId, [...(opportunitiesByContact.get(opportunity.contactId) ?? []), opportunity]);
  }
  const items: { contactId: string; username: string; decision: ReconciliationDecision; desiredStage?: string;
    currentStage?: string; reason?: string; opportunityIds: string[] }[] = [];
  for (const [contactId, records] of recordsByContact) {
    const username = records[0].username.toLowerCase().replace(/^@/, "");
    const opportunities = opportunitiesByContact.get(contactId) ?? [];
    const base = { contactId, username, opportunityIds: opportunities.map((row) => row.id) };
    if (topologyIssues.length) { items.push({ ...base, decision: "unresolved", reason: "pipeline_topology" }); continue; }
    if (records.length !== 1 || (contactsByUsername.get(username)?.size ?? 0) !== 1) {
      items.push({ ...base, decision: "duplicated", reason: "duplicate_directory_identity" }); continue;
    }
    const contact = contactById.get(contactId);
    if (!contact?.available) { items.push({ ...base, decision: "unresolved", reason: "contact_unavailable" }); continue; }
    const desiredStage = desiredAffiliateStage(contact.tags); const desiredId = stageGroups.get(desiredStage)![0].id;
    if (opportunities.length > 1) { items.push({ ...base, decision: "duplicated", desiredStage, reason: "multiple_pipeline_opportunities" }); continue; }
    if (!opportunities.length) { items.push({ ...base, decision: "created", desiredStage, reason: "opportunity_missing" }); continue; }
    const currentId = opportunities[0].pipelineStageId;
    if (!currentId || !stageById.has(currentId)) {
      items.push({ ...base, decision: "unresolved", desiredStage, reason: "unknown_current_stage" }); continue;
    }
    const currentStage = stageById.get(currentId)!;
    items.push({ ...base, decision: currentId === desiredId ? "skipped" : "moved", desiredStage, currentStage,
      reason: currentId === desiredId ? "already_reconciled" : "stage_differs" });
  }
  const counts = { eligible: recordsByContact.size, created: 0, moved: 0, skipped: 0, duplicated: 0, unresolved: 0 };
  for (const item of items) counts[item.decision]++;
  return { mode: "read_only" as const, ready: topologyIssues.length === 0, pipeline: { id: input.pipeline.id, name: input.pipeline.name },
    stages: input.pipeline.stages, counts, topologyIssues, items };
}
