import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { workflowRuns } from "./schema";
import { pipelineCreationPlanSchema, pipelineLedgerSchema, pipelineOutcomeSchema,
  type PipelineCreationPlan, type PipelineLedger } from "../pipeline/backfill-contracts";

const workflow = "pipeline_creation_backfill";
export class PipelineBackfillRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}
  async claim(raw: PipelineCreationPlan) {
    const plan = pipelineCreationPlanSchema.parse(raw);
    const result: PipelineLedger = { version: 1, plan, currentContactId: null, outcomes: [] };
    const [created] = await this.db.insert(workflowRuns).values({ workflow, workflowRunId: `pipeline-backfill:${plan.id}`,
      scheduledWindow: plan.id, status: "running", startedAt: new Date(), result }).onConflictDoNothing().returning({ id: workflowRuns.id });
    return { acquired: Boolean(created), progress: await this.progress(plan.id) };
  }
  async progress(planId: string) {
    pipelineCreationPlanSchema.shape.id.parse(planId);
    const [row] = await this.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflow, workflow),
      eq(workflowRuns.scheduledWindow, planId))).limit(1);
    if (!row) throw new Error("Unknown pipeline creation plan");
    return { state: row.status, reason: row.errorCode ?? undefined, ...pipelineLedgerSchema.parse(row.result) };
  }
  async find(planId: string) {
    try { return await this.progress(planId); } catch { return undefined; }
  }
  async beginContact(planId: string, contactId: string) {
    pipelineCreationPlanSchema.shape.id.parse(planId); pipelinePlanContact(contactId);
    const [row] = await this.db.update(workflowRuns).set({ result: sql`${workflowRuns.result} ||
      ${JSON.stringify({ currentContactId: contactId, uncertainContactId: null })}::jsonb`, updatedAt: new Date() }).where(and(
      eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'currentContactId' is null`,
      sql`not coalesce(${workflowRuns.result}->'outcomes', '[]'::jsonb) @> ${JSON.stringify([{ contactId }])}::jsonb`,
    )).returning({ id: workflowRuns.id });
    return Boolean(row);
  }
  async canCreate(planId: string, contactId: string) {
    const progress = await this.progress(planId);
    return progress.state === "running" && progress.currentContactId === contactId &&
      !progress.outcomes.some((outcome) => outcome.contactId === contactId);
  }
  async record(planId: string, raw: { contactId: string; opportunityId: string; evidence: "response" | "reconciled" }) {
    const outcome = pipelineOutcomeSchema.parse(raw);
    const [row] = await this.db.update(workflowRuns).set({
      result: sql`jsonb_set(${workflowRuns.result} || '{"currentContactId":null,"uncertainContactId":null}'::jsonb,
        '{outcomes}', coalesce(${workflowRuns.result}->'outcomes', '[]'::jsonb) || ${JSON.stringify([outcome])}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'currentContactId' = ${outcome.contactId}`)).returning({ id: workflowRuns.id });
    if (!row) throw new Error("Pipeline creation outcome could not be recorded");
  }
  async stop(planId: string, contactId: string, reason: "precondition_changed" | "provider_unknown" | "provider_rejected" | "read_failed") {
    await this.db.update(workflowRuns).set({ status: "paused", errorCode: reason,
      result: sql`${workflowRuns.result} || ${JSON.stringify({ currentContactId: null, uncertainContactId: contactId })}::jsonb`,
      updatedAt: new Date() }).where(and(eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId),
      eq(workflowRuns.status, "running"), sql`${workflowRuns.result}->>'currentContactId' = ${contactId}`));
    return this.progress(planId);
  }
  async complete(planId: string) {
    const [row] = await this.db.update(workflowRuns).set({ status: "succeeded", endedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
        sql`${workflowRuns.result}->>'currentContactId' is null`, sql`jsonb_array_length(${workflowRuns.result}->'outcomes') = 10`))
      .returning({ id: workflowRuns.id });
    if (!row) throw new Error("Pipeline creation plan is incomplete");
    return this.progress(planId);
  }
}
function pipelinePlanContact(value: string) { return pipelinePlanContactSchema.parse(value); }
const pipelinePlanContactSchema = pipelineCreationPlanSchema.shape.items.element.shape.contactId;
