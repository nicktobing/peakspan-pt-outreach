import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/clients/errors";
import { createPipelinePlan, type PipelineLedger } from "@/lib/pipeline/backfill-contracts";
import { createApprovedPipelineOpportunities } from "@/lib/pipeline/runtime";

const plan = createPipelinePlan({ version: 1, pipelineId: "pipeline", locationId: "location",
  items: Array.from({ length: 10 }, (_, index) => ({ contactId: `contact-${index}`, username: `trainer_${index}`,
    opportunityName: `PT Affiliate - @trainer_${index}`, stageId: "qualified", stageName: "Qualified" })) });
const approval = { confirmation: "create-approved-missing-opportunities" as const, planId: plan.id };
function ledger() {
  let claimed = false; let state: PipelineLedger & { state: "running" | "paused" | "succeeded"; reason: string | undefined } = {
    version: 1, plan, currentContactId: null, outcomes: [], state: "running", reason: undefined,
  };
  return {
    find: vi.fn(async () => claimed ? state : undefined),
    claim: vi.fn(async () => { const acquired = !claimed; claimed = true; return { acquired, progress: state }; }),
    progress: vi.fn(async () => state),
    beginContact: vi.fn(async (_planId: string, contactId: string) => {
      if (state.state !== "running" || state.currentContactId || state.outcomes.some((value) => value.contactId === contactId)) return false;
      state = { ...state, currentContactId: contactId }; return true;
    }),
    canCreate: vi.fn(async (_planId: string, contactId: string) => state.state === "running" && state.currentContactId === contactId),
    record: vi.fn(async (_planId: string, outcome: PipelineLedger["outcomes"][number]) => {
      state = { ...state, currentContactId: null, outcomes: [...state.outcomes, outcome] };
    }),
    stop: vi.fn(async (_planId: string, contactId: string, reason: string) => {
      state = { ...state, state: "paused", reason, currentContactId: null, uncertainContactId: contactId }; return state;
    }),
    complete: vi.fn(async () => { state = { ...state, state: "succeeded" }; return state; }),
  };
}
function deps() {
  const store = ledger();
  return { previewPlan: vi.fn(async () => plan), ledger: store, list: vi.fn(async () => [] as Opportunity[]),
    create: vi.fn(async (_planId: string, input: OpportunityInput) => ({ id: `opp-${input.contactId}` })),
    get: vi.fn(async (id: string) => { const contactId = id.replace(/^opp-/, ""); const item = plan.items.find((value) => value.contactId === contactId)!;
      return exact(item, id); }) };
}
type OpportunityInput = { pipelineId: string; pipelineStageId: string; contactId: string; name: string };
type Opportunity = { id: string; contactId: string; pipelineId: string; pipelineStageId: string; locationId: string;
  name: string; status: string };
function exact(item: typeof plan.items[number], id: string): Opportunity { return { id, contactId: item.contactId, pipelineId: plan.pipelineId,
  pipelineStageId: item.stageId, locationId: plan.locationId, name: item.opportunityName, status: "open" }; }

describe("approved pipeline creation backfill", () => {
  it("creates and authoritatively verifies only the immutable single-use plan", async () => {
    const dependencies = deps(); const result = await createApprovedPipelineOpportunities(approval, dependencies);
    expect(result).toMatchObject({ mode: "create_only", status: "complete" }); expect(result.created).toHaveLength(10);
    expect(dependencies.create).toHaveBeenCalledTimes(10); expect(dependencies.get).toHaveBeenCalledTimes(10);
    expect(dependencies.create.mock.calls[0][1]).toMatchObject({ pipelineId: "pipeline", pipelineStageId: "qualified",
      name: "PT Affiliate - @trainer_0" });
  });
  it("allows only one of two concurrent calls to execute the immutable plan", async () => {
    const dependencies = deps(); const results = await Promise.all([
      createApprovedPipelineOpportunities(approval, dependencies), createApprovedPipelineOpportunities(approval, dependencies),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_claimed", "complete"]);
    expect(dependencies.create).toHaveBeenCalledTimes(10);
  });
  it("blocks before claiming or writing when the immutable plan digest changes", async () => {
    const dependencies = deps(); dependencies.previewPlan.mockResolvedValue(createPipelinePlan({ version: 1,
      pipelineId: plan.pipelineId, locationId: plan.locationId,
      items: plan.items.map((item, index) => index === 0 ? { ...item, stageId: "changed" } : item) }));
    await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({ status: "blocked", reason: "preview_changed" });
    expect(dependencies.ledger.claim).not.toHaveBeenCalled(); expect(dependencies.create).not.toHaveBeenCalled();
  });
  it("stops on an uncertain create unless a fresh read proves every exact field", async () => {
    const dependencies = deps(); dependencies.create.mockRejectedValueOnce(new ProviderError("ghl", "unknown_outcome"));
    const stopped = await createApprovedPipelineOpportunities(approval, dependencies);
    expect(stopped).toMatchObject({ status: "stopped", reason: "provider_unknown", created: [], uncertainContactId: "contact-0" });
    expect(dependencies.create).toHaveBeenCalledTimes(1);
    const reconciled = deps(); reconciled.create.mockRejectedValueOnce(new ProviderError("ghl", "unknown_outcome"));
    reconciled.list.mockResolvedValueOnce([]).mockResolvedValueOnce([exact(plan.items[0], "opp-contact-0")]);
    await expect(createApprovedPipelineOpportunities(approval, reconciled)).resolves.toMatchObject({ status: "complete" });
    expect(reconciled.create).toHaveBeenCalledTimes(10);
  });
  it("returns the durable partial ledger when a later read fails", async () => {
    const dependencies = deps(); dependencies.list.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("read failed"));
    const result = await createApprovedPipelineOpportunities(approval, dependencies);
    expect(result).toMatchObject({ status: "stopped", reason: "read_failed", uncertainContactId: "contact-1",
      created: [{ contactId: "contact-0", opportunityId: "opp-contact-0" }] });
    expect(dependencies.create).toHaveBeenCalledTimes(1);
  });
  it("rejects a create response that cannot be verified with exact name, location and open status", async () => {
    const dependencies = deps(); dependencies.get.mockResolvedValueOnce({ ...exact(plan.items[0], "opp-contact-0"), status: "won" });
    dependencies.list.mockResolvedValueOnce([]).mockResolvedValueOnce([exact(plan.items[0], "different-exact-opportunity")]);
    const result = await createApprovedPipelineOpportunities(approval, dependencies);
    expect(result).toMatchObject({ status: "stopped", reason: "provider_unknown", created: [] });
    expect(dependencies.list).toHaveBeenCalledTimes(1);
  });
  it("rejects an authoritative GET whose body ID differs from the successful response ID", async () => {
    const dependencies = deps(); dependencies.get.mockResolvedValueOnce(exact(plan.items[0], "unexpected-id"));
    const result = await createApprovedPipelineOpportunities(approval, dependencies);
    expect(result).toMatchObject({ status: "stopped", reason: "provider_unknown", created: [] });
    await expect(dependencies.create.mock.results[0].value).resolves.toMatchObject({ id: "opp-contact-0" });
  });
});
