import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { canStartLike } from "@/lib/likes/runtime";
const fixture = vi.hoisted(() => ({ contact: { id: "contact", tags: ["qualified"] }, suppressed: false, disabled: false as boolean | undefined }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/db/settings", () => ({ getActionSwitch: async () => fixture.disabled === undefined ? undefined : { disabled: fixture.disabled } }));
vi.mock("@/lib/db/repositories", () => ({ ExecutionRepository: class { async isSuppressed() { return fixture.suppressed; } } }));
vi.mock("@/lib/clients/ghl", () => ({ GhlClient: class { async getContact() { return fixture.contact; } } }));
const target = { accountId: "123", accountUsername: "fixture_account", contactId: "contact", targetUsername: "fixture_target",
  postUrl: "https://www.instagram.com/reel/Fixture123/" };
beforeEach(() => {
  fixture.contact = { id: "contact", tags: ["qualified"] }; fixture.suppressed = false; fixture.disabled = false;
  const env = { IG_LIKE_ENABLED: "true", VERCEL_ENV: "production", OUTREACH_EMERGENCY_DISABLED: "false", IG_LIKE_ACCOUNT_ID: "123",
    IG_LIKE_ACCOUNT_USERNAME: target.accountUsername, IG_LIKE_CONTACT_ID: target.contactId, IG_LIKE_TARGET_USERNAME: target.targetUsername,
    IG_LIKE_POST_URL: target.postUrl, GHL_API_TOKEN: "fixture", GHL_LOCATION_ID: "fixture",
    IG_LIKE_COOKIES_JSON: JSON.stringify([{ name: "sessionid", value: "123%3Asynthetic-session" }, { name: "csrftoken", value: "synthetic-csrf" }, { name: "ds_user_id", value: "123" }]) };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
it("rechecks CRM qualification, stop tags, identity and local suppression", async () => {
  expect(await canStartLike(target)).toBe(true);
  fixture.suppressed = true; expect(await canStartLike(target)).toBe(false); fixture.suppressed = false;
  fixture.contact.tags = ["qualified", " Opted-Out "]; expect(await canStartLike(target)).toBe(false);
  fixture.contact.tags = []; expect(await canStartLike(target)).toBe(false);
  fixture.contact = { id: "wrong", tags: ["qualified"] }; expect(await canStartLike(target)).toBe(false);
});
it("requires an explicit database enable and exact configured pilot identity", async () => {
  fixture.disabled = undefined; expect(await canStartLike(target)).toBe(false);
  fixture.disabled = true; expect(await canStartLike(target)).toBe(false); fixture.disabled = false;
  expect(await canStartLike({ ...target, accountId: "999" })).toBe(false);
  vi.stubEnv("OUTREACH_EMERGENCY_DISABLED", "true"); expect(await canStartLike(target)).toBe(false);
});


