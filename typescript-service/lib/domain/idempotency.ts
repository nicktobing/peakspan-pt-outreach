import { createHash } from "node:crypto";

export function idempotencyKey(namespace: string, ...parts: string[]) {
  if (!/^[a-z][a-z0-9_-]*$/.test(namespace) || !parts.length || parts.some((part) => !part)) throw new Error("Invalid idempotency key input");
  return `${namespace}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
export function payloadHash(value: string) { return createHash("sha256").update(value).digest("hex"); }

