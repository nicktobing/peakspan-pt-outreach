import { ProviderError } from "../clients/errors";
import type { InstagramDmProvider, ProviderHealth, ProviderRunReference, ProviderRunStatus } from "./instagram";

export class DmDisabledProvider implements InstagramDmProvider {
  async validateCredentials(): Promise<ProviderHealth> { return { healthy: false, reason: "disabled" }; }
  async send(): Promise<ProviderRunReference> { throw new ProviderError("instagram", "disabled"); }
  async getStatus(): Promise<ProviderRunStatus> { throw new ProviderError("instagram", "disabled"); }
}

