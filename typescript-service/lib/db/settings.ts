import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import type { OutboundAction } from "@/lib/domain/outbound";
import { eq, like } from "drizzle-orm";

const prefix = "outbound_disabled:";

type ActionSwitchValue = {
  disabled: boolean;
  reason: string;
};

export async function listActionSwitches() {
  return getDb().select().from(settings).where(like(settings.key, `${prefix}%`));
}

export async function getActionSwitch(action: OutboundAction): Promise<ActionSwitchValue | undefined> {
  const [row] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, `${prefix}${action}`))
    .limit(1);

  return row?.value as ActionSwitchValue | undefined;
}

export async function setActionSwitch(input: {
  action: OutboundAction;
  disabled: boolean;
  reason: string;
  updatedBy: string;
}) {
  const key = `${prefix}${input.action}`;
  const [row] = await getDb()
    .insert(settings)
    .values({
      key,
      value: { disabled: input.disabled, reason: input.reason },
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: { disabled: input.disabled, reason: input.reason },
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}
