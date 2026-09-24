import { GhlClient } from "../clients/ghl";
import { getDb } from "../db/client";
import { AdmissionRepository, DIRECTORY_TAG, admissionInput } from "./admissions";
import { screenDirectory } from "./screen";
import { directoryFailureKey, directoryFailureText, FailureAlertRepository } from "../likes/failure-alerts";
import { ProviderError } from "../clients/errors";

export function directoryEnabled() { return process.env.VERCEL_ENV === "production" && process.env.DIRECTORY_LAUNCH_ENABLED === "true"; }
const location = () => { if (!process.env.GHL_LOCATION_ID) throw new Error("Missing location"); return process.env.GHL_LOCATION_ID; };
const ghl = (authorizeWrite?: () => Promise<boolean>) => new GhlClient(process.env.GHL_API_TOKEN ?? "", location(), { authorizeWrite });
export async function directoryRecords() { return new AdmissionRepository(getDb()).completed(location()); }
export async function directoryContactAllowed(contactId: string, username: string) {
  if (!directoryEnabled()) return false;
  const record = (await directoryRecords()).find((row) => row.contactId === contactId && row.username === username);
  if (!record) return false;
  const client = ghl(); const fields = await client.listCustomFields();
  const ids = new Set(fields.filter((f) => /(?:instagram|ig_profile|profile_url)/i.test(f.fieldKey)).map((f) => f.id));
  const contacts = await client.listContacts();
  if (!contacts.some((row) => row.id === contactId)) return false;
  return screenDirectory([record.lead, ...record.variants], contacts.filter((row) => row.id !== contactId), ids).results[0].status === "new_needs_qualification";
}
type AdmissionInput = ReturnType<typeof admissionInput.parse>;
function contactDetails(input: AdmissionInput) {
  const email = `${input.lead.email_address};${input.lead.public_email}`.split(/[;,\s]+/).find((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  let digits = input.lead.public_phone.replace(/\D/g, "");
  if (/^0[23478]\d{8}$/.test(digits)) digits = `61${digits.slice(1)}`;
  const phone = /^[+\d\s().-]+$/.test(input.lead.public_phone) && /^\d{8,15}$/.test(digits) ? `+${digits}` : undefined;
  return { email, phone };
}
async function createAndComplete(repository: AdmissionRepository, id: string, input: AdmissionInput, client: GhlClient,
  existing: Awaited<ReturnType<GhlClient["listContacts"]>>, ids: Set<string>) {
  const { email, phone } = contactDetails(input);
  let record = await repository.read(id);
  const displayName = input.lead.business_name.trim() || `@${record.data.username}`;
  await repository.set(id, { phase: "creating" });
  const created = await client.createDirectoryContact({ name: displayName, companyName: displayName,
    ...(input.lead.website_url ? { website: input.lead.website_url } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) });
  await repository.set(id, { phase: "verifying", contactId: created.id });
  if (existing.some((row) => row.id === created.id)) {
    await repository.set(id, { createdNew: false });
    throw new Error("Existing contact returned by create");
  }
  await repository.set(id, { createdNew: true });
  const fresh = await client.listContacts();
  const found = fresh.find((row) => row.id === created.id);
  if (!found || screenDirectory([input.lead, ...input.variants], fresh.filter((row) => row.id !== created.id), ids).results[0].status !== "new_needs_qualification") throw new Error("Post-create duplicate or visibility uncertainty");
  record = await repository.read(id);
  await repository.set(id, { phase: "noting" });
  await client.addNote(created.id, `Peakspan directory qualification (like stage only)\nInstagram: https://www.instagram.com/${record.data.username}/\n${input.qualification.rationale}\nEvidence: ${input.qualification.evidenceUrls.join(" ")}\nChecked: ${input.qualification.checkedAt}\nNo prior follow is asserted.`);
  await repository.set(id, { phase: "tagging" });
  await client.addTags(created.id, [DIRECTORY_TAG]);
  await repository.set(id, { phase: "complete" }, "succeeded");
}
async function pauseDirectoryImport(repository: AdmissionRepository, id: string, error: unknown) {
  const failed = await repository.read(id);
  await repository.set(id, { phase: "paused", pausedFrom: failed.data.phase,
    failureCode: error instanceof ProviderError ? `${error.provider}_${error.kind}_${error.status ?? 0}` : "verification_failed", reason: "import_needs_attention" }, "paused");
  const paused = await repository.read(id);
  await new FailureAlertRepository(getDb()).enqueue(directoryFailureKey(id, paused.data), {
    text: directoryFailureText(id, paused.data),
  });
}
export async function importDirectoryLead(raw: unknown) {
  if (!directoryEnabled()) throw new Error("Directory launch disabled");
  const input = admissionInput.parse(raw);
  const checkedAt = Date.parse(input.qualification.checkedAt);
  if (checkedAt > Date.now() + 60000 || Date.now() - checkedAt > 7 * 86400000) throw new Error("Qualification needs refresh");
  const repository = new AdmissionRepository(getDb());
  const claim = await repository.claim(location(), input);
  if (!claim.acquired) return repository.read(claim.id);
  const client = ghl(async () => directoryEnabled() && (await repository.read(claim.id)).status === "running");
  try {
    const fields = await client.listCustomFields();
    const ids = new Set(fields.filter((f) => /(?:instagram|ig_profile|profile_url)/i.test(f.fieldKey)).map((f) => f.id));
    const existing = await client.listContacts();
    if (screenDirectory([input.lead, ...input.variants], existing, ids).results[0].status !== "new_needs_qualification") {
      await repository.set(claim.id, { phase: "duplicate", reason: "existing_ghl_contact" }, "cancelled"); return repository.read(claim.id);
    }
    await createAndComplete(repository, claim.id, input, client, existing, ids);
  } catch (error) {
    await pauseDirectoryImport(repository, claim.id, error);
  }
  return repository.read(claim.id);
}

export async function inspectDirectoryImport(id: string) {
  const row = await new AdmissionRepository(getDb()).read(id);
  if (row.data.locationId !== location() || !row.data.contactId) return { ...row, inspection: { available: false } };
  const client = ghl(); const contact = await client.getContact(row.data.contactId);
  const fields = await client.listCustomFields();
  const ids = new Set(fields.filter((f) => /(?:instagram|ig_profile|profile_url)/i.test(f.fieldKey)).map((f) => f.id));
  const contacts = await client.listContacts();
  const check = screenDirectory([row.data.lead, ...row.data.variants], contacts.filter((c) => c.id !== row.data.contactId), ids).results[0];
  const added = Date.parse(contact.dateAdded ?? "");
  const createdDuringImport = contact.id === row.data.contactId && Number.isFinite(added) && added >= row.createdAt.getTime() && added <= row.updatedAt.getTime();
  return { ...row, inspection: { available: true, contactId: contact.id, tags: contact.tags, dateAdded: contact.dateAdded,
    presentInSearch: contacts.some((c) => c.id === contact.id), createdDuringImport, duplicateStatus: check.status, duplicateContactIds: check.matchedContactIds } };
}

/** Recovery can only verify/tag a known new contact. It has no create or note-send path. */
export async function reconcileDirectoryImport(id: string) {
  if (!directoryEnabled()) throw new Error("Directory launch disabled");
  const repository = new AdmissionRepository(getDb()); const initial = await repository.read(id);
  if (initial.data.locationId !== location()) throw new Error("Location mismatch");
  if (!await repository.claimReconciliation(id)) return repository.read(id);
  try {
    const inspected = await inspectDirectoryImport(id); const check = inspected.inspection;
    if (!check.available || !check.presentInSearch || check.duplicateStatus !== "new_needs_qualification" ||
      !(initial.data.createdNew === true || (initial.data.createdNew === undefined && check.createdDuringImport))) throw new Error("New contact provenance or duplicate check incomplete");
    const client = ghl(async () => directoryEnabled() && (await repository.read(id)).status === "running");
    await repository.set(id, { phase: "tagging" });
    await client.addTags(initial.data.contactId!, [DIRECTORY_TAG]);
    await repository.set(id, { phase: "complete", createdNew: true, reason: "known_contact_reconciled" }, "succeeded");
  } catch (error) {
    const failed = await repository.read(id);
    await repository.set(id, { phase: "paused", pausedFrom: failed.data.phase, failureCode: error instanceof ProviderError ? `${error.provider}_${error.kind}_${error.status ?? 0}` : "verification_failed", reason: "import_needs_attention" }, "paused");
  }
  return repository.read(id);
}

/** Retries a definitive rejected create once, after a settled fresh scan proves no matching contact exists. */
export async function retryRejectedDirectoryImport(id: string) {
  if (!directoryEnabled()) throw new Error("Directory launch disabled");
  const repository = new AdmissionRepository(getDb()); const row = await repository.read(id);
  if (row.data.locationId !== location() || row.status !== "paused" || row.data.contactId || row.data.pausedFrom !== "creating" ||
    row.data.failureCode !== "ghl_permanent_400" || row.data.retryCount || Date.now() - row.updatedAt.getTime() < 60000) throw new Error("Rejected create is not retryable");
  const checkedAt = Date.parse(row.data.qualification.checkedAt);
  if (checkedAt > Date.now() + 60000 || Date.now() - checkedAt > 7 * 86400000) throw new Error("Qualification needs refresh");
  const client = ghl(); const fields = await client.listCustomFields();
  const ids = new Set(fields.filter((f) => /(?:instagram|ig_profile|profile_url)/i.test(f.fieldKey)).map((f) => f.id));
  const contacts = await client.listContacts();
  if (screenDirectory([row.data.lead, ...row.data.variants], contacts, ids).results[0].status !== "new_needs_qualification") {
    throw new Error("A matching GHL contact exists");
  }
  if (!await repository.claimRejectedRetry(id)) return repository.read(id);
  const writer = ghl(async () => directoryEnabled() && (await repository.read(id)).status === "running");
  try { await createAndComplete(repository, id, row.data, writer, contacts, ids); }
  catch (error) { await pauseDirectoryImport(repository, id, error); }
  return repository.read(id);
}

