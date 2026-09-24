import { vi } from "vitest";

export function json(value: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}
export function fakeHttp(...responses: (Response | Error)[]) {
  return vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected HTTP request");
    if (response instanceof Error) throw response;
    return response;
  });
}
export const allowFixtureWrite = async () => true;

