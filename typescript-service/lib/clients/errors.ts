export type FailureKind = "disabled" | "invalid_input" | "invalid_response" | "authentication" | "permanent" | "transient" | "unknown_outcome" | "pagination";

// Never attach provider bodies, URLs, request data or original error causes.
export class ProviderError extends Error {
  constructor(public readonly provider: string, public readonly kind: FailureKind, public readonly status?: number) {
    super(`${provider}:${kind}${status === undefined ? "" : `:${status}`}`);
    this.name = "ProviderError";
  }
}

