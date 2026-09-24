import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { approvalBatches, messageAudit } from "./schema";
import { dmTargetSchema } from "../engagement/contracts";

export const dmDraftItemSchema = dmTargetSchema.pick({ contactId: true, targetUsername: true, text: true });
export const dmApprovalSnapshotSchema = z.object({ version: z.literal(1), accountId: dmTargetSchema.shape.accountId,
  accountUsername: dmTargetSchema.shape.accountUsername, items: z.array(dmDraftItemSchema).min(1).max(10) }).strict().superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      if (seen.has(item.contactId)) ctx.addIssue({ code: "custom", path: ["items", index, "contactId"], message: "Duplicate contact in DM approval batch" });
      seen.add(item.contactId);
    });
  });
export type DmApprovalSnapshot = z.infer<typeof dmApprovalSnapshotSchema>;

export class DmApprovalRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}
  async create(value: DmApprovalSnapshot) {
    const snapshot = dmApprovalSnapshotSchema.parse(value);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(approvalBatches).values({ snapshot }).returning();
      await tx.insert(messageAudit).values(snapshot.items.map((item) => ({ contactId: item.contactId,
        kind: `dm:${row.id}`, promptVersion: "manual-approved-v1", messageText: item.text,
        complianceResult: { compliant: true, approvalRequired: true } })));
      return row;
    });
  }
  async read(id: string) {
    z.string().uuid().parse(id);
    const [row] = await this.db.select().from(approvalBatches).where(eq(approvalBatches.id, id));
    if (!row) throw new Error("Unknown DM approval batch");
    return { ...row, data: dmApprovalSnapshotSchema.parse(row.snapshot) };
  }
  async decide(id: string, decision: "approved" | "rejected", decidedBy: string) {
    z.string().uuid().parse(id); z.string().trim().min(1).max(200).parse(decidedBy);
    const [row] = await this.db.update(approvalBatches).set({ status: decision, decidedAt: new Date(), decidedBy, updatedAt: new Date() })
      .where(and(eq(approvalBatches.id, id), eq(approvalBatches.status, "pending"))).returning();
    if (!row) throw new Error("DM approval batch is not pending");
    return row;
  }
  async allows(id: string, item: z.infer<typeof dmDraftItemSchema>, accountId: string, accountUsername: string) {
    const row = await this.read(id);
    if (row.status !== "approved" || row.data.accountId !== accountId || row.data.accountUsername !== accountUsername) return false;
    return row.data.items.some((candidate) => candidate.contactId === item.contactId && candidate.targetUsername === item.targetUsername && candidate.text === item.text);
  }
}

