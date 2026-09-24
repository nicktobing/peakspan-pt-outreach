import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/clients/errors";
import { createPipelinePlan, type PipelineLedger } from "@/lib/pipeline/backfill-contracts";
import { createApprovedPipelineOpportunities } from "@/lib/pipeline/runtime";

const plan = createPipelinePlan({ version: 1, pipelineId: "pipeline", locationId: "location",
  items: Array.from({ length: 10 }, (_, index) => ({ contactId: `contact-${index}`, username: `trainer_${index}`,
    opportunityName: `PT Affiliate - @trainer_${index}`, stageId: "qualified", stageName: "Qualified" })) });
const approval = { confirmation: "create-approved-missing-opportunities" as const, planId: plan.id };
const initialLeaseId = "11111111-1111-4111-8111-111111111111";
function ledger() {
  let claimed = false; let state: PipelineLedger & { state: "running" | "paused" | "succeeded"; reason: string | undefined } = {
    version: 1, plan, currentContactId: null, outcomes: [], state: "running", reason: undefined, leaseId: initialLeaseId,
  };
  return {
    find: vi.fn(async () => claimed ? state : undefined),
    claim: vi.fn(async () => { const acquired = !claimed; claimed = true; return { acquired, progress: state }; }),
    resume: vi.fn(async () => { const acquired = state.state === "paused"; if (acquired) state = { ...state, state: "running",
      leaseId: "22222222-2222-4222-8222-222222222222" };
      return { acquired, progress: state }; }),
    progress: vi.fn(async () => state),
    beginContact: vi.fn(async (_planId: string, contactId: string, leaseId: string) => {
      if (state.state !== "running" || state.leaseId !== leaseId || state.currentContactId ||
        state.outcomes.some((value) => value.contactId === contactId)) return false;
      state = { ...state, currentContactId: contactId }; return true;
    }),
    canCreate: vi.fn(async (_planId: string, contactId: string, leaseId: string) => state.state === "running" &&
      state.leaseId === leaseId && state.currentContactId === contactId && state.writeAttemptedContactId === contactId),
    consumeCreateAuthorization: vi.fn(async (_planId: string, contactId: string, leaseId: string) => {
      if (state.leaseId !== leaseId || state.currentContactId !== contactId || state.writeAttemptedContactId !== contactId ||
        state.authorizationConsumedContactId) return false;
      state = { ...state, authorizationConsumedContactId: contactId, uncertainSince: new Date().toISOString() }; return true;
    }),
    markWriteAttempted: vi.fn(async (_planId: string, contactId: string, leaseId: string) => {
      if (state.leaseId !== leaseId || state.currentContactId !== contactId || state.writeAttemptedContactId) return false;
      state = { ...state, writeAttemptedContactId: contactId, authorizationConsumedContactId: null,
        uncertainSince: null }; return true;
    }),
    clearContact: vi.fn(async (_planId: string, contactId: string, leaseId: string) => {
      if (state.leaseId !== leaseId || (state.currentContactId !== contactId && state.uncertainContactId !== contactId)) return false;
      state = { ...state, currentContactId: null, uncertainContactId: null, writeAttemptedContactId: null,
        authorizationConsumedContactId: null, uncertainSince: null };
      return true;
    }),
    record: vi.fn(async (_planId: string, outcome: PipelineLedger["outcomes"][number], leaseId: string) => {
      if (state.leaseId !== leaseId) throw new Error("stale lease");
      state = { ...state, currentContactId: null, uncertainContactId: null, writeAttemptedContactId: null,
        authorizationConsumedContactId: null, uncertainSince: null,
        outcomes: [...state.outcomes, outcome] };
    }),
    stop: vi.fn(async (_planId: string, contactId: string, reason: string, leaseId: string) => {
      if (state.leaseId !== leaseId) throw new Error("stale lease");
      state = { ...state, state: "paused", reason, currentContactId: null, uncertainContactId: contactId }; return state;
    }),
    complete: vi.fn(async (_planId: string, leaseId: string) => { if (state.leaseId !== leaseId) throw new Error("stale lease");
      state = { ...state, state: "succeeded" }; return state; }),
  };
}
function deps() {
  const store = ledger(); const opportunities = new Map<string, Opportunity>();
  return { previewPlan: vi.fn(async () => plan), ledger: store,
    list: vi.fn(async (contactId: string) => opportunities.has(contactId) ? [opportunities.get(contactId)!] : []),
    stage: vi.fn(async (contactId: string) => plan.items.find((item) => item.contactId === contactId)?.stageName ?? null),
    create: vi.fn(async (_planId: string, _leaseId: string, input: OpportunityInput) => {
      if (!(await store.consumeCreateAuthorization(_planId, input.contactId, _leaseId))) throw new Error("write not authorized");
      const item = plan.items.find((value) => value.contactId === input.contactId)!;
      opportunities.set(input.contactId, exact(item, `opp-${input.contactId}`)); return { id: `opp-${input.contactId}` }; }),
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
    expect(dependencies.create.mock.calls[0][2]).toMatchObject({ pipelineId: "pipeline", pipelineStageId: "qualified",
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
  it("always stops immediately on an uncertain create and defers reconciliation", async () => {
    const dependencies = deps(); dependencies.create.mockImplementationOnce(async (planId, leaseId, input) => {
      await dependencies.ledger.consumeCreateAuthorization(planId, input.contactId, leaseId);
      throw new ProviderError("ghl", "unknown_outcome");
    });
    const stopped = await createApprovedPipelineOpportunities(approval, dependencies);
    expect(stopped).toMatchObject({ status: "stopped", reason: "provider_unknown", created: [], uncertainContactId: "contact-0" });
    expect(dependencies.create).toHaveBeenCalledTimes(1);
    expect(dependencies.list).toHaveBeenCalledTimes(1);
  });
  it("returns the durable partial ledger when a later read fails", async () => {
    const dependencies = deps(); dependencies.list.mockResolvedValueOnce([])
      .mockResolvedValueOnce([exact(plan.items[0], "opp-contact-0")]).mockRejectedValueOnce(new Error("read failed"));
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
  it("stops when the contact's live stage changes after approval", async () => {
    const dependencies = deps(); dependencies.stage.mockResolvedValueOnce("Disqualified");
    await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({
      status: "stopped", reason: "precondition_changed", created: [], uncertainContactId: "contact-0",
    });
    expect(dependencies.create).not.toHaveBeenCalled();
  });
  it("rejects any additional opportunity discovered after a successful create", async () => {
    const dependencies = deps(); const expected = exact(plan.items[0], "opp-contact-0");
    dependencies.list.mockResolvedValueOnce([]).mockResolvedValueOnce([expected, { ...expected, id: "duplicate" }]);
    await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({
      status: "stopped", reason: "provider_unknown", created: [], uncertainContactId: "contact-0",
    });
  });
  it("resumes a paused same-plan run after a pre-write read failure", async () => {
    const dependencies = deps(); dependencies.list.mockRejectedValueOnce(new Error("temporary read failure"));
    await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({
      status: "stopped", reason: "read_failed", created: [],
    });
    await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({ status: "complete" });
    expect(dependencies.create).toHaveBeenCalledTimes(10);
  });
  it("never retries a consumed create authorization whose provider outcome remains unknown", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
    try {
      const dependencies = deps(); dependencies.create.mockImplementationOnce(async (planId, leaseId, input) => {
        await dependencies.ledger.consumeCreateAuthorization(planId, input.contactId, leaseId);
        throw new ProviderError("ghl", "unknown_outcome");
      });
      await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({
        status: "stopped", reason: "provider_unknown", created: [],
      });
      vi.setSystemTime(new Date("2026-09-24T00:06:00.000Z"));
      await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({
        status: "stopped", reason: "provider_unknown", created: [],
      });
      expect(dependencies.create).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("resumes after a settled read proves the exact opportunity from an unknown write", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
    try {
      const dependencies = deps(); dependencies.create.mockImplementationOnce(async (planId, leaseId, input) => {
        await dependencies.ledger.consumeCreateAuthorization(planId, input.contactId, leaseId);
        throw new ProviderError("ghl", "unknown_outcome");
      });
      await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({ status: "stopped" });
      vi.setSystemTime(new Date("2026-09-24T00:06:00.000Z"));
      dependencies.list.mockResolvedValueOnce([exact(plan.items[0], "provider-created")]);
      await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({ status: "complete" });
      expect(dependencies.create).toHaveBeenCalledTimes(10);
    } finally { vi.useRealTimers(); }
  });
  it("starts the settlement window when authorization is consumed, after slow preflight reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
    try {
      const dependencies = deps(); dependencies.create.mockImplementationOnce(async (planId, leaseId, input) => {
        vi.setSystemTime(new Date("2026-09-24T00:06:00.000Z"));
        await dependencies.ledger.consumeCreateAuthorization(planId, input.contactId, leaseId);
        throw new ProviderError("ghl", "unknown_outcome");
      });
      await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({ status: "stopped" });
      await expect(createApprovedPipelineOpportunities(approval, dependencies)).resolves.toMatchObject({
        status: "stopped", reason: "provider_unknown",
      });
      expect(dependencies.list).toHaveBeenCalledTimes(1);
      expect(dependencies.create).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
