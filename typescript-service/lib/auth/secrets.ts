import { timingSafeEqual } from "node:crypto";

export function secretMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;

  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;

  return timingSafeEqual(actualBytes, expectedBytes);
}

export function requireBearerSecret(
  request: Request,
  expected: string,
): Response | undefined {
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  if (!secretMatches(supplied, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export function requireHeaderSecret(
  request: Request,
  headerName: string,
  expected: string,
): Response | undefined {
  if (!secretMatches(request.headers.get(headerName), expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}
