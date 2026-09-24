import { beforeEach, vi } from "vitest";

// Contract tests must inject fixture transports. An omitted fixture cannot use
// the host's credentials or contact a real provider by accident.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Live HTTP disabled in tests"); }));
});

