import { z } from "zod";
import { normalizeInstagramUsername } from "../domain/normalization";

const cell = z.string().max(4000).default("");
export const directoryLeadSchema = z.object({ business_name: cell, website_url: cell, public_email: cell,
  email_address: cell, instagram_url: cell, public_phone: cell });
export const leadScreenInput = z.object({ leads: z.array(directoryLeadSchema).min(1).max(4000) }).strict();
export type DirectoryLead = z.infer<typeof directoryLeadSchema>;
export type ExistingContact = { id: string; email?: string | null; phone?: string | null; website?: string | null;
  companyName?: string | null; firstName?: string | null; lastName?: string | null;
  customFields: { id: string; value?: unknown; fieldValue?: unknown }[] };

function emails(value: string) {
  return value.toLowerCase().split(/[;,\s]+/).filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}
function phone(value: string) {
  if (!/^[+\d\s().-]+$/.test(value)) return null;
  let result = value.replace(/\D/g, "");
  // This directory is Australian. Normalize local and international AU formats.
  if (/^0[23478]\d{8}$/.test(result)) result = `61${result.slice(1)}`;
  return /^\d{8,15}$/.test(result) ? result : null;
}
function website(value: string) {
  if (!value.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".")) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    // Social/link directory hosts are shared by unrelated businesses.
    if (["instagram.com", "facebook.com", "linkedin.com", "linktr.ee", "youtube.com", "tiktok.com"].some((v) => host === v || host.endsWith(`.${v}`))) return null;
    return host;
  } catch { return null; }
}
function name(value: string) { return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function add(keys: Set<string>, kind: string, value: string | null) { if (value) keys.add(`${kind}:${value}`); }
function leadKeys(lead: DirectoryLead) {
  const keys = new Set<string>();
  for (const value of emails(`${lead.public_email};${lead.email_address}`)) add(keys, "email", value);
  add(keys, "phone", phone(lead.public_phone)); add(keys, "website", website(lead.website_url));
  add(keys, "instagram", normalizeInstagramUsername(lead.instagram_url));
  add(keys, "name", name(lead.business_name));
  return keys;
}
function contactKeys(contact: ExistingContact, profileFields: Set<string>) {
  const keys = new Set<string>();
  for (const value of emails(contact.email ?? "")) add(keys, "email", value);
  add(keys, "phone", phone(contact.phone ?? "")); add(keys, "website", website(contact.website ?? ""));
  add(keys, "name", name(contact.companyName ?? ""));
  add(keys, "name", name(`${contact.firstName ?? ""} ${contact.lastName ?? ""}`));
  for (const field of contact.customFields) {
    const value = field.value ?? field.fieldValue;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) if (typeof entry === "string" &&
      (profileFields.has(field.id) || /^(https?:\/\/)?(www\.)?instagram\.com\//i.test(entry.trim()))) {
      add(keys, "instagram", normalizeInstagramUsername(entry));
    }
  }
  const contactWebsite = contact.website?.trim() ?? "";
  if (/^(https?:\/\/)?(www\.)?instagram\.com\//i.test(contactWebsite))
    add(keys, "instagram", normalizeInstagramUsername(contactWebsite));
  return keys;
}

/** Read-only screening. A result is a snapshot, never permission to send or upsert. */
export function screenDirectory(leads: DirectoryLead[], contacts: ExistingContact[], profileFields = new Set<string>()) {
  const keys = leads.map(leadKeys);
  const parent = leads.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const index = new Map<string, number>();
  // Union all identities before deciding: a later duplicate may connect to an existing GHL contact.
  keys.forEach((values, i) => { for (const key of values) {
    const prior = index.get(key); if (prior !== undefined) parent[root(i)] = root(prior); else index.set(key, i);
  } });
  const groups = new Map<number, number[]>();
  leads.forEach((_, i) => { const r = root(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const ghlIndex = new Map<string, Set<string>>();
  for (const contact of contacts) for (const key of contactKeys(contact, profileFields)) {
    const ids = ghlIndex.get(key) ?? new Set<string>(); ids.add(contact.id); ghlIndex.set(key, ids);
  }
  const results = leads.map((lead, i) => ({ row: i + 2, businessName: lead.business_name,
    username: normalizeInstagramUsername(lead.instagram_url), status: "hold_missing_instagram",
    matchedContactIds: [] as string[], matchTypes: [] as string[], sourceRows: [] as number[], duplicateOfRow: null as number | null }));
  for (const members of groups.values()) {
    const matched = new Set<string>(); const reasons = new Set<string>();
    const groupKeys = new Set(members.flatMap((i) => [...keys[i]]));
    for (const key of groupKeys) for (const id of ghlIndex.get(key) ?? []) { matched.add(id); reasons.add(key.split(":")[0]); }
    const usernames = new Set(members.map((i) => results[i].username).filter(Boolean));
    const representative = members.find((i) => results[i].username) ?? members[0];
    for (const i of members) {
      const result = results[i]; result.matchedContactIds = [...matched].sort(); result.matchTypes = [...reasons].sort();
      result.sourceRows = members.map((member) => member + 2);
      if (matched.size) result.status = [...reasons].some((r) => r !== "name") ? "skip_existing_ghl" : "hold_possible_ghl_duplicate";
      else if (usernames.size > 1) result.status = "hold_conflicting_identities";
      else if (i !== representative) { result.status = "skip_duplicate_in_file"; result.duplicateOfRow = representative + 2; }
      else if (result.username) result.status = "new_needs_qualification";
    }
  }
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return { checkedAt: new Date().toISOString(), totalRows: leads.length, ghlContactsChecked: contacts.length, counts,
    outreachStarted: false, results };
}

