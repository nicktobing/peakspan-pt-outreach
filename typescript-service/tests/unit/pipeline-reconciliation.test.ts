import { describe, expect, it } from "vitest";
import { buildPipelineReconciliationPreview, desiredAffiliateStage, PT_AFFILIATE_STAGES } from "@/lib/pipeline/reconciliation";

const pipeline = { id: "pipeline", name: "PT Affiliate Pipeline",
  stages: PT_AFFILIATE_STAGES.map((name, index) => ({ id: `stage-${index}`, name })) };
const records = [
  { importId: "i-create", contactId: "create", username: "create_pt" },
  { importId: "i-move", contactId: "move", username: "move_pt" },
  { importId: "i-skip", contactId: "skip", username: "skip_pt" },
  { importId: "i-duplicate", contactId: "duplicate", username: "duplicate_pt" },
  { importId: "i-unresolved", contactId: "unresolved", username: "unresolved_pt" },
];

describe("read-only pipeline reconciliation planning", () => {
  it("maps the most advanced exact CRM tag to the verified live stage", () => {
    expect(desiredAffiliateStage(["peakspan-directory-qualified"])).toBe("Qualified");
    expect(desiredAffiliateStage(["ig-comment-1", "ig-comment-3"])).toBe("Comment 3x");
    expect(desiredAffiliateStage(["ig-comment-3", "outreach-sent", "responded", "interested"])).toBe("Interested");
    expect(desiredAffiliateStage(["affiliate-onboarded", "disqualified"])).toBe("Affiliate Onboarded");
  });
  it("counts create, move, skip, duplicate and unresolved without producing mutations", () => {
    const contacts = records.map((row) => ({ contactId: row.contactId, tags: row.contactId === "move" ? ["ig-comment-1"] :
      ["peakspan-directory-qualified"], available: row.contactId !== "unresolved" }));
    const opportunities = [
      { id: "move-opp", contactId: "move", pipelineStageId: "stage-1" },
      { id: "skip-opp", contactId: "skip", pipelineStageId: "stage-1" },
      { id: "dup-1", contactId: "duplicate", pipelineStageId: "stage-1" },
      { id: "dup-2", contactId: "duplicate", pipelineStageId: "stage-3" },
    ];
    const preview = buildPipelineReconciliationPreview({ records, contacts, pipeline, opportunities });
    expect(preview).toMatchObject({ mode: "read_only", ready: true,
      counts: { eligible: 5, created: 1, moved: 1, skipped: 1, duplicated: 1, unresolved: 1 } });
    expect(preview.items.find((item) => item.contactId === "move")).toMatchObject({ currentStage: "Qualified", desiredStage: "Comment 1x" });
  });
  it("fails closed on an unexpected or incomplete pipeline topology", () => {
    const preview = buildPipelineReconciliationPreview({ records: records.slice(0, 1), contacts: [],
      pipeline: { ...pipeline, stages: pipeline.stages.slice(0, -1) }, opportunities: [] });
    expect(preview).toMatchObject({ ready: false, counts: { eligible: 1, unresolved: 1 } });
    expect(preview.topologyIssues).toContain("stage:Affiliate Onboarded");
  });
  it("fails closed when all exact stages exist in the wrong order", () => {
    const reordered = { ...pipeline, stages: [pipeline.stages[1], pipeline.stages[0], ...pipeline.stages.slice(2)] };
    const preview = buildPipelineReconciliationPreview({ pipeline: reordered, records: [
      { importId: "i1", contactId: "c1", username: "trainer" },
    ], contacts: [{ contactId: "c1", tags: [], available: true }], opportunities: [] });
    expect(preview).toMatchObject({ ready: false, counts: { eligible: 1, unresolved: 1 } });
    expect(preview.topologyIssues).toContain("stage_order");
  });
  it("does not reprocess duplicate durable Instagram identities", () => {
    const preview = buildPipelineReconciliationPreview({ records: [
      { importId: "one", contactId: "a", username: "same_pt" }, { importId: "two", contactId: "b", username: "@same_pt" },
    ], contacts: [{ contactId: "a", tags: [], available: true }, { contactId: "b", tags: [], available: true }], pipeline, opportunities: [] });
    expect(preview.counts).toMatchObject({ eligible: 2, duplicated: 2, created: 0 });
  });
});
