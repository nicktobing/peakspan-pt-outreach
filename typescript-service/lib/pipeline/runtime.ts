import { GhlClient } from "../clients/ghl";
import { directoryRecords } from "../leads/runtime";
import { buildPipelineReconciliationPreview, PT_AFFILIATE_PIPELINE } from "./reconciliation";

function required(name: "GHL_API_TOKEN" | "GHL_LOCATION_ID") {
  const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value;
}

export async function previewPipelineReconciliation() {
  const records = (await directoryRecords()).map((row) => ({ importId: row.id, contactId: row.contactId!, username: row.username }));
  const client = new GhlClient(required("GHL_API_TOKEN"), required("GHL_LOCATION_ID"));
  const pipelines = await client.listPipelines();
  const configuredId = process.env.GHL_PIPELINE_ID;
  const matches = pipelines.filter((pipeline) => pipeline.name === PT_AFFILIATE_PIPELINE && (!configuredId || pipeline.id === configuredId));
  if (matches.length !== 1) return { mode: "read_only" as const, ready: false, pipeline: null, stages: [],
    counts: { eligible: new Set(records.map((row) => row.contactId)).size, created: 0, moved: 0, skipped: 0, duplicated: 0,
      unresolved: new Set(records.map((row) => row.contactId)).size },
    topologyIssues: [matches.length ? "pipeline_ambiguous" : "pipeline_not_found"], items: [] };
  const pipeline = matches[0];
  const [opportunities, contacts] = await Promise.all([
    client.listOpportunities({ pipelineId: pipeline.id, status: "all" }),
    Promise.all([...new Set(records.map((row) => row.contactId))].map(async (contactId) => {
      try { const contact = await client.getContact(contactId); return { contactId, tags: contact.tags, available: contact.id === contactId }; }
      catch { return { contactId, tags: [], available: false }; }
    })),
  ]);
  return buildPipelineReconciliationPreview({ records, contacts, pipeline, opportunities });
}
