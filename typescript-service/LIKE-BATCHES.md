# Instagram like sessions

This extends the verified one-reel pilot without enabling follow, comment or DM providers. GHL stays the CRM. An account can have only one unfinished session; a paused session remains a lock until explicitly recovered or cancelled. Cancellation closes proven-unsent reservations while retaining their deduplication and budget records. Actions that entered the sending phase survive cancellation and prevent another action until reconciled.

## Eligibility and selection

Select contacts tagged qualified and ig-followed, excluding ig-liked, stop tags and local suppression. Resolve usernames from the GHL profile_url custom field, using field metadata rather than guessing from names or emails. GHL_IG_PROFILE_FIELD_ID can override an ambiguous mapping. Deduplicate usernames and skip the acting account. Re-fetch eligibility and profile identity before scraping and immediately before the like.

Use apify/instagram-post-scraper with one username, at most 10 results, skipPinnedPosts=true and a 30-day cutoff. Scraping requires its separate enable flag and never uses the Instagram session cookie. Prefer the newest owned post; use a verified coauthor post only when no owned post qualifies. Ignore previously selected URLs in the same session. Malformed/error datasets pause the session rather than counting as missing posts. Three confirmed no-post selections in execute mode exclude the contact; previews never increment that counter.

Provider contract: https://apify.com/apify/instagram-post-scraper/input-schema

## Explicit workload controls

Defaults are 10 distinct profiles and 10 attempted actions per session, 120 seconds between completed/skipped items, and 29 attempted Instagram actions in a rolling 24 hours. Profile, session-action and daily-action configuration reject values above 29. These are operator workload limits, not Instagram-approved or ban-proof thresholds. One follow plus one like plus one comment counts as three actions, not one profile. Only likes have an implemented writer; future follow/comment writers must reserve through the same account lock and budget. The service cannot account for manual Instagram activity or actions sent by old n8n workflows. Disable the overlapping n8n owner before live cutover.

The shared database budget counts failed and unknown attempts too. A single database lock serializes account reservations, including the legacy single-reel endpoint. An unresolved action blocks new actions. Repeated requests cannot reset the budget or release an unknown claim. No outreach execution schedules are enabled.

## Durable waits and failure handling

The database stores the session, current contact, selected post, scraper/action references, due time and phase. Reserving a like also attaches it to the session in the same transaction, preventing orphaned actions if the worker stops. Workflow sleep persists its wake-up; closing the browser does not own or cancel the execution. Each step reads current state and rechecks gates. Provider polling is bounded. A step that exhausts retries pauses the whole session with an explicit reason. Remaining items stay queued; they do not silently advance.

If a paid scraper or Instagram action starts but its response/reference is lost, do not resend it. That session needs manual reconciliation. Known references can be observed again. A successful like followed by a GHL error retries only tag reconciliation. Batch resume never resets the provider sending phase. Cancellation stops future work but cannot retract a request already accepted by a provider.

GET reports mark paused sessions as needsAttention. Running sessions whose last activity AND scheduled wake time are over 15 minutes overdue are reported as stalled_session. Vercel Workflow also retains failed step history if the database itself cannot record the pause.

## Slack failure alerts and daily report

Live operational failures go only to the private DM resolved for the pinned Peakspan member U09N5128R0T. The shared destination #outreach-pt, channel C0B047Q4DEU, receives one count-only daily report at 17:00 Australia/Sydney. An hourly Vercel cron performs a Sydney-time window check and a per-date database claim, so daylight-saving changes and repeated cron calls cannot create another daily report. The shared report contains aggregate import, like, batch and incident counts, without contact-level details.

The separate authenticated live-alert cron checks every five minutes. Paused/failed sessions are picked up on the next check; stalled work is picked up after the 15-minute overdue threshold. Normal waits, healthy sessions and unchanged incidents produce no repeated DMs. The daily report path verifies the pinned workspace and shared channel independently, so a private-DM failure does not suppress the shared report.

Production requires IG_FAILURE_ALERTS_ENABLED=true, SLACK_BOT_TOKEN, SLACK_LIVE_FAILURE_MEMBER_ID=U09N5128R0T, SLACK_CHANNEL_OUTREACH=C0B047Q4DEU and SLACK_TEAM_ID matching the bot's auth.test identity. The bot needs permission to open the DM and `chat:write` permission for both destinations. These reporting switches are independent of Instagram sending and the outreach emergency switch. The routes do not scrape, like, follow, comment, modify GHL or resume sessions. No database migration is needed.

GET /api/admin/instagram/alerts (admin bearer token) verifies the workspace, exact pinned member, resolved DM channel and shared report channel, and shows recent live-delivery states. POST to that route with {"requestId":"UUID","test":true} queues one fixed, clearly labelled private-DM test; reuse the UUID after an uncertain response. Secrets never belong in the request. Both `/api/cron/instagram-failures` and `/api/cron/instagram-daily-report` require CRON_SECRET. Confirm the DM test separately from the shared daily report.

The database outbox deduplicates incidents and claims each send once. An uncertain Slack response or abandoned sending claim is marked unknown, not automatically resent; the cron keeps returning a failure status until that uncertainty is reconciled. Status inspection retains these records. If Slack or the database is unavailable, the endpoint returns an error for Vercel logs; this monitor cannot guarantee a Slack notification about its own infrastructure outage. Live workspace verification and a confirmed test message are required before claiming delivery is active.

## Operator API

All routes require the existing admin bearer token. Never include credentials in request bodies.

- GET /api/admin/instagram/batches?view=fields: GHL field IDs/keys only.
- GET /api/admin/instagram/batches?view=candidates: eligible capped contacts and limits; no scraper or Instagram writes.
- POST /api/admin/instagram/batches with requestId (UUID) and mode (preview or execute): immutable session request; reuse the same UUID after an uncertain response.
- GET /api/admin/instagram/batches?id=UUID: full safe session progress and durable workflow ID.
- GET /api/admin/instagram/batches: latest 100 session summaries, including needsAttention.
- PATCH /api/admin/instagram/batches with sessionId and action=resume: recover paused or overdue running sessions, including a crash before initial dispatch. Only one concurrent recovery wins. Preserve scheduled due times and allow only safe known-reference recovery or pre-send work; uncertain starts are rejected.
- PATCH with action=cancel: stop that session while preserving action claims.
- POST /api/admin/instagram/like/reconcile with id (action UUID): observe a known provider run and finish its GHL tag, including after session cancellation. This never starts another like and still requires the write gates. A reserved action that has never entered the sending phase can resume in its paused session; an uncertain starting action cannot.

Preview requires IG_BATCH_DISCOVERY_ENABLED=true in Production. It starts only the bounded public scraper and stores selections, never sends likes or updates GHL tags. Execute additionally requires IG_BATCH_ENABLED=true, IG_LIKE_ENABLED=true, OUTREACH_EMERGENCY_DISABLED=false and the database like switch enabled. Saved defaults remain disabled. New code uses existing database tables; no schema migration is required.

## Evidence boundary

Fixture tests cover concurrent reservations, shared action counting, replay, known-reference recovery, uncertain-start rejection, post ownership, suppression changes, persisted due times and provider failures. Local orchestration tests are not proof of platform uptime or notification delivery. The original single-reel canary passed with user visual confirmation; a real multi-contact execute session requires its own controlled cutover.

