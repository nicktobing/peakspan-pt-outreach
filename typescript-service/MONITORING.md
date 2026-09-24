# Milestone 3 monitoring

Monitoring is implemented but disabled for live operation. No Vercel cron schedule is registered by this change. The dry-run endpoint evaluates a supplied snapshot and never reads or writes GHL or Postgres.

## Endpoints and schedules

| Endpoint | Authentication | Behavior |
| --- | --- | --- |
| `GET /api/cron/monitoring/daily_report` | Bearer `CRON_SECRET` | Previous Sydney day's execution counts/costs plus a current GHL pipeline snapshot |
| `GET /api/cron/monitoring/reply_monitor` | Bearer `CRON_SECRET` | Process normalized, unprocessed Postgres inbox records and queue reply alerts |
| `GET /api/cron/monitoring/escalation_monitor` | Bearer `CRON_SECRET` | Monitor unresolved Postgres escalation tickets and queue SLA/backlog alerts |
| `POST /api/admin/dry-run` | Bearer `ADMIN_API_TOKEN` | Return follow/comment/DM and follow-up decisions for a supplied contact snapshot |

After credential rotation, preview checks, account verification and explicit cutover, an operator can configure hourly invocations of each cron endpoint. Guards use `Australia/Sydney`: daily reports at the configured local hour (default 09:00), reply and escalation scans in even-numbered local hours. Any invocation within the hour belongs to the same window. Autumn's repeated hour creates one window; a nonexistent spring hour is skipped. A previous-day report covers the full local calendar day, including 23-hour and 25-hour DST days. There is no automatic historical backfill.

The reporting period applies to execution records' `created_at`; costs represent currently known values for those actions. GHL totals are a current snapshot, not a historical reconstruction. Missing cost values are counted explicitly. All opportunities must belong to the configured pipeline and have a stage ID; inconsistent data fails rather than producing misleading totals.

## Controls

- `MONITORING_ENABLED=false` by default. Disabled cron requests return before DB or provider access; disabled durable executions return without provider access.
- `MONITORING_ALERTS_ENABLED=false` by default. Alert delivery also requires `MONITORING_ENABLED=true` and `VERCEL_ENV=production`. Preview cannot deliver alerts.
- `MONITORING_REPORT_HOUR=9` sets the daily report hour in Sydney.
- `MONITORING_BUSINESS_START=9` and `MONITORING_BUSINESS_END=17` define the assumed Monday–Friday business day. These defaults are an implementation assumption because the source spec specifies four business hours but no office hours.
- `MONITORING_HOLIDAYS` is an optional comma-separated list of local ISO dates to exclude. No holiday calendar is fetched or inferred.

Monitoring is separate from the outreach emergency stop so an operator can eventually receive safety alerts while outreach is paused. This change does not alter `OUTREACH_EMERGENCY_DISABLED`, any outreach action switch, or the disabled DM provider. It does not authorize enabling either monitoring flag.

GHL credentials and `GHL_PIPELINE_ID` are read only when a report runs. Slack credentials are read only when an enabled alert is delivered. Reply and SLA processing need no GHL credentials. No OpenAI or Apify operation is performed by monitoring.

## Durable state and failure handling

`0001_monitoring.sql` adds the alert queue, escalation queue, inbox processing markers and business-run results. Existing data is preserved.

Cron claims a `(workflow, scheduled_window)` row before asking Workflow DevKit to start. A concurrent or repeated request returns `duplicate`. Until a run ID is returned, the row holds a deterministic `dispatch:` reference. An uncertain start keeps the claim and marks a still-pending row paused with `dispatch_unknown`; it is never automatically dispatched again. Crashes before recording dispatch also require manual reconciliation. Disabling monitoring between dispatch and the first durable step leaves the reserved business row for operator inspection; the durable execution returns disabled. Do not delete/release such claims merely to retry.

Reply processing transactionally preserves the inbox message, activates local suppression, inserts one alert using the provider message ID as a deduplication key, and marks the message processed. Existing opt-out evidence is preserved. A repeated provider ID with a different contact fails. Message previews are not included in alerts or workflow step outputs. Every reply blocks pending outreach locally; this alert-only phase does not add GHL tags or send a response.

Alert payloads are immutable once queued. The dispatcher atomically changes pending to sending, then records sent with the provider message ID. A known pre-send feature denial returns the alert to pending. All other errors become unknown; a crash can leave sending. Neither unknown nor sending is automatically resent. Check provider history and reconcile manually before any operator retry. This gives one send attempt after a claim, not a claim of exactly-once delivery across a network failure. Pending alerts are drained by subsequent runs when delivery is explicitly enabled.

A business run can finish data processing successfully while alerts remain pending or uncertain; its result records delivery counts and whether alerts were enabled. Exhausted execution-step retries record a sanitized failure when monitoring is still enabled. Provider response bodies and original errors are not placed in workflow failure messages.

## Queue ownership and remaining integration

The reply monitor reads up to 500 unprocessed `inbox_messages` per run, oldest first. A validated inbox adapter must populate that normalized table using globally namespaced provider message IDs and verified contact IDs. The current migration has an inbox provider interface but no validated live Instagram inbox implementation; this work does not pretend an empty provider response means a healthy inbox.

`escalation_queue` holds contact ID, priority (`high` or `normal`), reason, creation time and optional resolution time. A future authenticated ingestion/CRM synchronization path must own this queue. This milestone monitors it; it does not infer escalation timestamps from contact tags or create GHL tasks. Normal unresolved tickets receive one initial alert. Once four configured business hours have elapsed, reminders deduplicate per two-hour window. A backlog above ten adds a window-level alert. High-priority tickets are labeled urgent in the queue but delivery is bounded by the scheduled scan; immediate email/SMS escalation and autonomous response templates from the older spec are outside this alert-only milestone.

## Dry-run example

Send an authenticated JSON request with:

```json
{
  "contact": {
    "tags": ["qualified"],
    "suppressed": false,
    "outreachDate": null,
    "followupCount": 0
  },
  "asOf": "2026-09-08T00:00:00Z"
}
```

The response is explicitly a simulation of supplied data. It cannot authorize sending and does not substitute for fresh GHL, suppression, approval or kill-switch checks.

## Verification

Synthetic tests cover DST guards/day boundaries, business-hour SLA calculations, authentication, invalid snapshots, disabled routes without dependency access, concurrent cron claims, uncertain dispatch, report reconciliation, transactional reply suppression, duplicate alert claims and unknown delivery outcomes. PGlite applies both migrations twice. Workflow integration tests execute the disabled monitoring path with both monitoring flags forced false; they do not access hosted Postgres or providers. Full hosted and live-source integration remains a launch prerequisite.

Source mapping: architecture sections 6.5, 7, 9, 10 and 13; build-plan Milestone 3; `specs/done/05-escalation-exception-handling.md` for the four-business-hour SLA, two-hour reminders and backlog threshold. Architecture's human-managed reply policy overrides the older autonomous-response proposals.

