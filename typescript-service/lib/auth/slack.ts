import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 60 * 5;

export function verifySlackSignature(input: {
  body: string;
  signature: string | null;
  timestamp: string | null;
  signingSecret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const timestamp = Number(input.timestamp);
  if (!input.signature || !Number.isInteger(timestamp)) return false;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${timestamp}:${input.body}`)
    .digest("hex")}`;
  const suppliedBytes = Buffer.from(input.signature);
  const expectedBytes = Buffer.from(expected);

  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}
