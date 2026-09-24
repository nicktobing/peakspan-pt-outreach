import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { workflowRuns } from "./schema";
import { pipelineCreationPlanSchema, pipelineLedgerSchema, pipelineOutcomeSchema,
  type PipelineCreationPlan, type PipelineLedger } from "../pipeline/backfill-contracts";

const workflow = "pipeline_creation_backfill";
export class PipelineBackfillRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}
  async claim(raw: PipelineCreationPlan) {
    const plan = pipelineCreationPlanSchema.parse(raw);
    const result: PipelineLedger = { version: 1, plan, currentContactId: null, outcomes: [], uncertainContactId: null,
      writeAttemptedContactId: null, authorizationConsumedContactId: null, uncertainSince: null, leaseId: randomUUID() };
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
  async resume(planId: string, staleBefore: Date) {
    pipelineCreationPlanSchema.shape.id.parse(planId);
    const leaseId = randomUUID();
    const [row] = await this.db.update(workflowRuns).set({ status: "running", errorCode: null,
      result: sql`${workflowRuns.result} || ${JSON.stringify({ leaseId })}::jsonb`, updatedAt: new Date() }).where(and(
      eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId),
      sql`(${workflowRuns.status} = 'paused' or (${workflowRuns.status} = 'running' and ${workflowRuns.updatedAt} < ${staleBefore}))`,
    )).returning({ id: workflowRuns.id });
    return { acquired: Boolean(row), progress: await this.progress(planId) };
  }
  async beginContact(planId: string, contactId: string, leaseId: string) {
    pipelineCreationPlanSchema.shape.id.parse(planId); pipelinePlanContact(contactId);
    const [row] = await this.db.update(workflowRuns).set({ result: sql`${workflowRuns.result} ||
      ${JSON.stringify({ currentContactId: contactId, uncertainContactId: null })}::jsonb`, updatedAt: new Date() }).where(and(
      eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'leaseId' = ${leaseId}`,
      sql`${workflowRuns.result}->>'currentContactId' is null`,
      sql`not coalesce(${workflowRuns.result}->'outcomes', '[]'::jsonb) @> ${JSON.stringify([{ contactId }])}::jsonb`,
    )).returning({ id: workflowRuns.id });
    return Boolean(row);
  }
  async canCreate(planId: string, contactId: string, leaseId: string) {
    const progress = await this.progress(planId);
    return progress.state === "running" && progress.leaseId === leaseId && progress.currentContactId === contactId &&
      progress.writeAttemptedContactId === contactId &&
      !progress.authorizationConsumedContactId &&
      !progress.outcomes.some((outcome) => outcome.contactId === contactId);
  }
  async consumeCreateAuthorization(planId: string, contactId: string, leaseId: string) {
    const consumedAt = new Date().toISOString();
    const [row] = await this.db.update(workflowRuns).set({ result: sql`${workflowRuns.result} ||
      ${JSON.stringify({ authorizationConsumedContactId: contactId, uncertainSince: consumedAt })}::jsonb`, updatedAt: new Date() }).where(and(
      eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'leaseId' = ${leaseId}`, sql`${workflowRuns.result}->>'currentContactId' = ${contactId}`,
      sql`${workflowRuns.result}->>'writeAttemptedContactId' = ${contactId}`,
      sql`coalesce(${workflowRuns.result}->>'authorizationConsumedContactId', '') = ''`,
    )).returning({ id: workflowRuns.id });
    return Boolean(row);
  }
  async markWriteAttempted(planId: string, contactId: string, leaseId: string) {
    const [row] = await this.db.update(workflowRuns).set({ result: sql`${workflowRuns.result} ||
      ${JSON.stringify({ writeAttemptedContactId: contactId, authorizationConsumedContactId: null,
        uncertainSince: null })}::jsonb`, updatedAt: new Date() }).where(and(
      eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'leaseId' = ${leaseId}`,
      sql`${workflowRuns.result}->>'currentContactId' = ${contactId}`,
      sql`coalesce(${workflowRuns.result}->>'writeAttemptedContactId', '') = ''`,
    )).returning({ id: workflowRuns.id });
    return Boolean(row);
  }
  async clearContact(planId: string, contactId: string, leaseId: string) {
    const [row] = await this.db.update(workflowRuns).set({ result: sql`${workflowRuns.result} ||
      '{"currentContactId":null,"uncertainContactId":null,"writeAttemptedContactId":null,"authorizationConsumedContactId":null,"uncertainSince":null}'::jsonb`,
      updatedAt: new Date() }).where(and(eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId),
      eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'leaseId' = ${leaseId}`,
      sql`(${workflowRuns.result}->>'currentContactId' = ${contactId} or ${workflowRuns.result}->>'uncertainContactId' = ${contactId})`,
    )).returning({ id: workflowRuns.id });
    return Boolean(row);
  }
  async record(planId: string, raw: { contactId: string; opportunityId: string; evidence: "response" | "reconciled" }, leaseId: string) {
    const outcome = pipelineOutcomeSchema.parse(raw);
    const [row] = await this.db.update(workflowRuns).set({
      result: sql`jsonb_set(${workflowRuns.result} ||
        '{"currentContactId":null,"uncertainContactId":null,"writeAttemptedContactId":null,"authorizationConsumedContactId":null,"uncertainSince":null}'::jsonb,
        '{outcomes}', coalesce(${workflowRuns.result}->'outcomes', '[]'::jsonb) || ${JSON.stringify([outcome])}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'leaseId' = ${leaseId}`,
      sql`(${workflowRuns.result}->>'currentContactId' = ${outcome.contactId} or
        ${workflowRuns.result}->>'uncertainContactId' = ${outcome.contactId})`)).returning({ id: workflowRuns.id });
    if (!row) throw new Error("Pipeline creation outcome could not be recorded");
  }
  async stop(planId: string, contactId: string, reason: "precondition_changed" | "provider_unknown" | "provider_rejected" | "read_failed",
    leaseId: string) {
    const [row] = await this.db.update(workflowRuns).set({ status: "paused", errorCode: reason,
      result: sql`${workflowRuns.result} || ${JSON.stringify({ currentContactId: null, uncertainContactId: contactId })}::jsonb`,
      updatedAt: new Date() }).where(and(eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId),
      eq(workflowRuns.status, "running"),
      sql`${workflowRuns.result}->>'leaseId' = ${leaseId}`,
      sql`(${workflowRuns.result}->>'currentContactId' = ${contactId} or ${workflowRuns.result}->>'uncertainContactId' = ${contactId})`))
      .returning({ id: workflowRuns.id });
    if (!row) throw new Error("Pipeline creation stop lost its lease");
    return this.progress(planId);
  }
  async complete(planId: string, leaseId: string) {
    const [row] = await this.db.update(workflowRuns).set({ status: "succeeded", endedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workflowRuns.workflow, workflow), eq(workflowRuns.scheduledWindow, planId), eq(workflowRuns.status, "running"),
        sql`${workflowRuns.result}->>'leaseId' = ${leaseId}`,
        sql`${workflowRuns.result}->>'currentContactId' is null`, sql`jsonb_array_length(${workflowRuns.result}->'outcomes') = 10`))
      .returning({ id: workflowRuns.id });
    if (!row) throw new Error("Pipeline creation plan is incomplete");
    return this.progress(planId);
  }
}
function pipelinePlanContact(value: string) { return pipelinePlanContactSchema.parse(value); }
const pipelinePlanContactSchema = pipelineCreationPlanSchema.shape.items.element.shape.contactId;
