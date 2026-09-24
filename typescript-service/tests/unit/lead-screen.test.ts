import { describe, expect, it } from "vitest";
import { directoryLeadSchema, screenDirectory, type ExistingContact } from "@/lib/leads/screen";
const lead = (input: Record<string, string>) => directoryLeadSchema.parse(input);
const contact = (input: Partial<ExistingContact>): ExistingContact => ({ id: "existing", customFields: [], ...input });
describe("directory duplicate screening", () => {
  it("skips existing GHL emails case-insensitively regardless of prior outreach status", () => {
    const result = screenDirectory([lead({ instagram_url: "https://instagram.com/test_gym/", email_address: "INFO@GYM.TEST" })],
      [contact({ email: "info@gym.test" })]);
    expect(result.results[0]).toMatchObject({ status: "skip_existing_ghl", matchedContactIds: ["existing"], matchTypes: ["email"] });
    expect(result.outreachStarted).toBe(false);
  });
  it("normalizes Australian phones and website variants", () => {
    const result = screenDirectory([lead({ public_phone: "0401 234 567" }), lead({ website_url: "https://www.gym.test/location?utm_source=x" })],
      [contact({ phone: "+61 401 234 567" }), contact({ id: "site", website: "http://gym.test/" })]);
    expect(result.counts.skip_existing_ghl).toBe(2);
  });
  it("matches full Instagram custom fields and explicitly mapped handles", () => {
    const result = screenDirectory([lead({ instagram_url: "@test_gym" })], [contact({ customFields: [
      { id: "unknown", value: "https://www.instagram.com/TEST_GYM/" }] })]);
    expect(result.counts.skip_existing_ghl).toBe(1);
    expect(screenDirectory([lead({ instagram_url: "test_gym" })], [contact({ customFields: [{ id: "ig", value: "TEST_GYM" }] })], new Set(["ig"])).counts.skip_existing_ghl).toBe(1);
  });
  it("propagates a later GHL match through a duplicate chain", () => {
    const result = screenDirectory([
      lead({ instagram_url: "test_gym", public_email: "a@gym.test" }),
      lead({ public_email: "a@gym.test", public_phone: "0401234567" }),
      lead({ public_phone: "0401234567", email_address: "known@gym.test" }),
    ], [contact({ email: "known@gym.test" })]);
    expect(result.counts.skip_existing_ghl).toBe(3);
  });
  it("recognizes Instagram websites with surrounding GHL whitespace", () => {
    expect(screenDirectory([lead({ instagram_url: "test_gym" })], [contact({ website: " https://www.instagram.com/TEST_GYM/  " })]).counts.skip_existing_ghl).toBe(1);
  });
  it("chooses one profile-bearing representative and never treats shared blanks as duplicates", () => {
    const result = screenDirectory([lead({ email_address: "a@gym.test" }), lead({ instagram_url: "test_gym", email_address: "a@gym.test" }), lead({}), lead({})], []);
    expect(result.results[0]).toMatchObject({ status: "skip_duplicate_in_file", duplicateOfRow: 3 });
    expect(result.counts).toEqual({ skip_duplicate_in_file: 1, new_needs_qualification: 1, hold_missing_instagram: 2 });
  });
  it("holds conflicting profiles and name-only GHL matches", () => {
    expect(screenDirectory([lead({ instagram_url: "gym_one", website_url: "gym.test" }), lead({ instagram_url: "gym_two", website_url: "gym.test" })], []).counts.hold_conflicting_identities).toBe(2);
    expect(screenDirectory([lead({ business_name: "Gym - One", instagram_url: "gym_one" })], [contact({ companyName: "GYM ONE" })]).counts.hold_possible_ghl_duplicate).toBe(1);
  });
  it("rejects post links and does not join unrelated social website hosts", () => {
    const result = screenDirectory([lead({ instagram_url: "https://instagram.com/reel/abc/", website_url: "https://facebook.com/one" }),
      lead({ instagram_url: "gym_two", website_url: "https://facebook.com/two" })], []);
    expect(result.counts).toEqual({ hold_missing_instagram: 1, new_needs_qualification: 1 });
  });
});

