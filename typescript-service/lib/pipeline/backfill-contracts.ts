import { createHash } from "node:crypto";
import { z } from "zod";

export const pipelinePlanItemSchema = z.object({ contactId: z.string().min(1).max(200), username: z.string().min(1).max(200),
  opportunityName: z.string().min(1).max(250), stageId: z.string().min(1).max(200), stageName: z.string().min(1).max(200) }).strict();
const pipelinePlanCoreSchema = z.object({ version: z.literal(1), pipelineId: z.string().min(1).max(200),
  locationId: z.string().min(1).max(200), items: z.array(pipelinePlanItemSchema).length(10) }).strict();
export const pipelineCreationPlanSchema = pipelinePlanCoreSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type PipelineCreationPlan = z.infer<typeof pipelineCreationPlanSchema>;
export const pipelineOutcomeSchema = z.object({ contactId: z.string(), opportunityId: z.string(),
  evidence: z.enum(["response", "reconciled"]) }).strict();
export const pipelineLedgerSchema = z.object({ version: z.literal(1), plan: pipelineCreationPlanSchema,
  currentContactId: z.string().nullable(), outcomes: z.array(pipelineOutcomeSchema),
  uncertainContactId: z.string().nullable().optional() }).strict();
export type PipelineLedger = z.infer<typeof pipelineLedgerSchema>;

export function createPipelinePlan(input: z.input<typeof pipelinePlanCoreSchema>) {
  const core = pipelinePlanCoreSchema.parse({ ...input, items: [...input.items].sort((a, b) => a.contactId.localeCompare(b.contactId)) });
  return pipelineCreationPlanSchema.parse({ ...core,
    id: createHash("sha256").update(JSON.stringify(core)).digest("hex") });
}
