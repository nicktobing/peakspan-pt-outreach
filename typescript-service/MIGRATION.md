# Migration implementation record

Milestone 1 provides the local Next.js/Workflow foundation. Milestone 2 adds shared clients and pure campaign decisions. No business workflow, schedule, or provider mutation is enabled by these modules.

## Traceability

| Source | TypeScript replacement | Behavior |
| --- | --- | --- |
| Architecture sections 7, 9, 10 | `lib/db/repositories.ts`, `lib/domain/idempotency.ts` | Database uniqueness owns event, schedule, action and inbox claims; unknown actions stay paused |
| Architecture sections 5, 8, 11 | `lib/clients/`, `lib/config/providers.ts`, `lib/providers/` | Validated provider boundaries, sanitized errors, default-disabled mutations and DM provider |
| Phase 2 qualification rules; architecture 6.2 | `lib/domain/qualification.ts`, `lib/clients/openai.ts` | 70/40 score boundaries, conservative missing-data scoring, prompt version and input hash |
| Architecture 6.3 and 6.4 | `lib/domain/eligibility.ts`, `lib/domain/contact-state.ts` | Follow/comment/DM prerequisites and success-only markers |
| `phase-3-outreach/node-code/filter-qualified.js` | `lib/domain/eligibility.ts` | Exact tag matching replaces the unsafe substring match |
| `phase-3-outreach/node-code/compliance-validator.js` | `lib/domain/compliance.ts` | Existing blocked terms, link/word limits and conservative UTF-16 emoji count |
| `phase-4-pipeline-followups/scripts/check-followup-due.js` | `lib/domain/eligibility.ts` | Day 3/7/14 decisions, day 15 Cold after three completed follow-ups, suppression |
| `phase-4-pipeline-followups/scripts/manage-stage-transition.js` | `lib/domain/contact-state.ts` | Reply, opt-out and Cold decisions; additive/removal tag sets |

Qualification uses the architecture's explicit three-way routing: scores 40–69 stay Identified. The older standalone script routed this range to Disqualified; that behavior is not retained. Empty messages are rejected, whitespace is counted consistently, and HTTP link detection is case-insensitive. These safety corrections have regression coverage. Profile normalization currently covers Instagram; Facebook discovery is not implemented.

## Provider contracts and retry policy

GHL targets the documented `v3` header and current camelCase opportunity filters. Contacts use `POST /contacts/search` with standard page/pageLimit pagination. Repeated records, inconsistent totals and the 10,000-record standard-search ceiling fail explicitly rather than silently returning incomplete data. Larger installations need cursor pagination verified against the account before cutover. Notes and tasks use their documented all-items endpoints. Tags use the additive/removal endpoints and never replace the full contact tag array.

Read and explicitly idempotent requests retry transient network errors, 408, 429 and 5xx responses up to three attempts. Rate limits honor Retry-After up to 30 seconds; longer waits return a transient error for future durable orchestration. Non-idempotent writes retry only explicit 429 responses. Network failures, 5xx responses and invalid successful write responses are unknown outcomes requiring reconciliation, not automatic resends. HTTP redirects are rejected, and provider error bodies/causes are never attached to application errors.

Every write requires an explicit authorization callback checked immediately before each request attempt. `createReadOnlyClients` never supplies one. Future workflow integrations must combine database reservation, deployment/action kill switches, suppression and approval checks before allowing a side effect. A callback by itself does not implement business idempotency. Monitoring workflows added in Milestone 3 are guarded by a separate default-disabled feature flag; the no-op smoke route remains available.

OpenAI Responses uses a strict JSON schema plus local validation, rejects refusals/incomplete results and records model, prompt version, input hash and token usage. Slack approval buttons reference a batch UUID; immutable batch persistence, callback verification and approval orchestration belong to Milestone 6. Apify run success alone is not proof an Instagram action succeeded: the like adapter now requires one matching success dataset row; future action adapters also need their own verified result contracts.

## Verification and remaining launch work

`npm test` runs synthetic provider contracts, pure domain tests, and in-memory PGlite tests that apply the committed Postgres migration twice and exercise claim uniqueness and suppression. Fixture tests never call provider APIs. `npm run test:integration` retains the durable Workflow smoke test; `npm run check` includes both suites and the production build.

PGlite executes PostgreSQL in-process; it does not verify hosted Postgres networking, permissions, extensions or production concurrency across machines. Preview deployment, account-specific provider contract verification, credential rotation, live stage/field IDs and service canaries remain outstanding. The separate manual like observation is recorded in LIKES.md. Existing n8n ownership is unchanged. Standalone legacy node-code files may also contain embedded credentials; do not use them as credential sources or fixtures.

## API references checked during implementation

- [HighLevel contact search](https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced/), [tag addition](https://marketplace.gohighlevel.com/docs/ghl/contacts/add-tags/), [opportunity search](https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunity/)
- [Apify API](https://docs.apify.com/api/v2/getting-started)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postmessage), [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- [PGlite](https://pglite.dev/docs/)

## Milestone 3

See [MONITORING.md](./MONITORING.md) for cron guards, alert queue semantics, reply suppression, reporting, SLA monitoring, dry-run requests, configuration, and verification limits. No live schedules or provider operations were enabled.

## Like-only pilot

User-prioritized work adds `lib/likes/`, `lib/db/likes.ts`, `lib/providers/instagram-like.ts`, `lib/config/likes.ts`, `lib/workflows/instagram-like.ts`, and authenticated admin routes. Existing action attempts store per-account/post reservations and a versioned result phase; no schema migration is required. A separate `like` switch defaults off. See [LIKES.md](./LIKES.md). This does not mark the planned follow/comment milestone complete.


