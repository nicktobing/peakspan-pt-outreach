import { z } from "zod";
import { JsonClient, parseInput, resourceId, type TransportOptions } from "./http";
import { ProviderError } from "./errors";

const id = z.string().min(1);
const contact = z.object({ id, tags: z.array(z.string()).default([]), firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(), email: z.string().nullable().optional(), website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(), companyName: z.string().nullable().optional(),
  dateAdded: z.string().nullable().optional(),
  customFields: z.array(z.object({ id, value: z.unknown().optional(), fieldValue: z.unknown().optional() })).default([]) });
const opportunity = z.object({ id, contactId: id.optional(), pipelineId: id.optional(), pipelineStageId: id.optional(), status: z.string().optional() });
const pipelineStage = z.object({ id, name: z.string().trim().min(1) });
const pipeline = z.object({ id, name: z.string().trim().min(1), stages: z.array(pipelineStage) });
const note = z.object({ id, body: z.string() });
const task = z.object({ id, title: z.string(), completed: z.boolean().optional() });
const tags = z.object({ tags: z.array(z.string().trim().min(1)).min(1).max(100) });

export class GhlClient {
  private readonly http: JsonClient;
  constructor(token: string, private readonly locationId: string, options: TransportOptions = {}) {
    parseInput("ghl", id, token); resourceId(locationId);
    this.http = new JsonClient("ghl", "https://services.leadconnectorhq.com", { Authorization: `Bearer ${token}`, Version: "v3" }, options);
  }
  async listContacts() {
    const results: z.infer<typeof contact>[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const batch = await this.http.request("/contacts/search", z.object({ contacts: z.array(contact), total: z.number().int().nonnegative().optional() }),
        { method: "POST", readOnly: true, body: { locationId: this.locationId, page, pageLimit: 100 } });
      for (const item of batch.contacts) {
        if (seen.has(item.id)) throw new ProviderError("ghl", "pagination");
        seen.add(item.id); results.push(item);
      }
      if (batch.contacts.length < 100) {
        if (batch.total !== undefined && batch.total > results.length) throw new ProviderError("ghl", "pagination");
        return results;
      }
      if (batch.total === results.length) return results;
    }
    // Standard search pagination has a 10k ceiling. Never return a partial list.
    throw new ProviderError("ghl", "pagination");
  }
  async getContact(contactId: string) {
    return (await this.http.request(`/contacts/${resourceId(contactId)}`, z.object({ contact }))).contact;
  }
  async createDirectoryContact(input: { name: string; companyName: string; website?: string; email?: string; phone?: string }) {
    const body = parseInput("ghl", z.object({ name: z.string().trim().min(1).max(250), companyName: z.string().trim().min(1).max(250),
      website: z.url().optional(), email: z.email().optional(), phone: z.string().regex(/^\+\d{8,15}$/).optional() }).strict(), input);
    // Create only. Never upsert or update a matched existing contact.
    return (await this.http.request("/contacts/", z.object({ contact }), { method: "POST", body: {
      ...body, firstName: body.name, locationId: this.locationId, source: "Peakspan directory like launch", tags: ["peakspan-directory-staged"],
    } })).contact;
  }
  async listCustomFields() {
    return (await this.http.request(`/locations/${resourceId(this.locationId)}/customFields`,
      z.object({ customFields: z.array(z.object({ id, fieldKey: z.string() })) }))).customFields;
  }
  async listNotes(contactId: string) {
    return (await this.http.request(`/contacts/${resourceId(contactId)}/notes`, z.object({ notes: z.array(note) }))).notes;
  }
  async addNote(contactId: string, body: string) {
    return this.http.request(`/contacts/${resourceId(contactId)}/notes`, z.object({ note }), {
      method: "POST", body: parseInput("ghl", z.object({ body: z.string().trim().min(1).max(20_000) }), { body }),
    });
  }
  async listTasks(contactId: string) {
    return (await this.http.request(`/contacts/${resourceId(contactId)}/tasks`, z.object({ tasks: z.array(task) }))).tasks;
  }
  async createTask(contactId: string, input: { title: string; body?: string; dueDate: string; completed: boolean; assignedTo?: string }) {
    const body = parseInput("ghl", z.object({ title: z.string().trim().min(1), body: z.string().optional(),
      dueDate: z.iso.datetime({ offset: true }), completed: z.boolean(), assignedTo: id.optional() }), input);
    return this.http.request(`/contacts/${resourceId(contactId)}/tasks`, z.object({ task }), { method: "POST", body });
  }
  async addTags(contactId: string, values: string[]) {
    return this.http.request(`/contacts/${resourceId(contactId)}/tags`, tags, {
      method: "POST", idempotent: true, body: parseInput("ghl", tags, { tags: [...new Set(values)] }),
    });
  }
  async removeTags(contactId: string, values: string[]) {
    return this.http.request(`/contacts/${resourceId(contactId)}/tags`, z.object({ tags: z.array(z.string()) }), {
      method: "DELETE", idempotent: true, body: parseInput("ghl", tags, { tags: [...new Set(values)] }),
    });
  }
  async listOpportunities(filters: { contactId?: string; pipelineId?: string; status?: "open" | "won" | "lost" | "abandoned" | "all" } = {}) {
    const clean = parseInput("ghl", z.object({ contactId: id.optional(), pipelineId: id.optional(), status: z.enum(["open", "won", "lost", "abandoned", "all"]).optional() }), filters);
    const results: z.infer<typeof opportunity>[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 1000; page++) {
      const query = new URLSearchParams({ locationId: this.locationId, limit: "100", page: String(page), ...clean });
      const batch = await this.http.request(`/opportunities/search?${query}`, z.object({ opportunities: z.array(opportunity) }));
      for (const item of batch.opportunities) {
        if (seen.has(item.id)) throw new ProviderError("ghl", "pagination");
        seen.add(item.id); results.push(item);
      }
      if (batch.opportunities.length < 100) return results;
    }
    throw new ProviderError("ghl", "pagination");
  }
  async listPipelines() {
    return (await this.http.request(`/opportunities/pipelines?${new URLSearchParams({ locationId: this.locationId })}`,
      z.object({ pipelines: z.array(pipeline) }))).pipelines;
  }
  async transitionOpportunity(opportunityId: string, pipelineStageId: string) {
    return this.http.request(`/opportunities/${resourceId(opportunityId)}`, z.object({ opportunity }), {
      method: "PUT", idempotent: true, body: { pipelineStageId: resourceId(pipelineStageId) },
    });
  }
}

