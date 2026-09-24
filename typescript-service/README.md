# PeakSpan PT Outreach TypeScript Service

This directory contains the durable TypeScript replacement for the existing n8n outreach workflows. The first two milestones provide the application foundation, shared provider clients, execution repositories, and pure campaign logic. Monitoring and a manually triggered Instagram like pilot are now implemented with live operation disabled by default.

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and replace the placeholder values.
3. Apply the foundation migration with `npm run db:migrate`.
4. Run `npm run dev`.
5. Check `/api/health` and `/api/ready`.

Run all local checks with:

```sh
npm run check
```

## Safety defaults

- `OUTREACH_EMERGENCY_DISABLED` defaults to `true`.
- Preview and development deployments cannot perform outbound actions.
- Each action remains disabled in the database until it is explicitly enabled.
- Cron routes provide a no-op smoke test and separately disabled monitoring; no like schedule is registered.

## Foundation endpoints

| Endpoint | Authentication | Purpose |
|---|---|---|
| `GET /api/health` | None | Process health; does not inspect dependencies |
| `GET /api/ready` | None | Confirms the database is reachable |
| `GET /api/cron/smoke` | Bearer `CRON_SECRET` | Starts a durable no-op workflow |
| `GET /api/admin/kill-switch` | Bearer `ADMIN_API_TOKEN` | Lists per-action switches |
| `POST /api/admin/kill-switch` | Bearer `ADMIN_API_TOKEN` | Enables or disables one action |

See the [architecture](../specs/todo/06-n8n-to-typescript-architecture.md) and [build plan](../specs/todo/07-n8n-to-typescript-build-plan.md) for the migration contract.

## Deployment prerequisites

The legacy exports contain exposed credentials. Rotate and revoke the old GHL, OpenAI, Apify, and Instagram session credentials before any deployment. Use an isolated test database and test credentials for preview verification. No preview deployment or live migration has been performed by the local checks.

The Workflow compiler creates lib/workflows/.gitignore to exclude its .swc cache; retain this generated ignore rule. Integration runtime data and generated bundles are ignored at the repository root.


Logging accepts fixed event names and only diagnostic identifiers/counts. Do not pass provider responses, contact payloads, message bodies, URLs, or raw error text; unknown context fields are omitted. Add new event names explicitly when implementing later workflows.


See [MIGRATION.md](./MIGRATION.md) for source traceability, contract assumptions, retry behavior, fixture/database verification, and launch prerequisites.


Milestone 3 adds disabled monitoring workflows and an authenticated snapshot dry-run endpoint. See [MONITORING.md](./MONITORING.md) for operation and remaining live-source prerequisites.

The like-only pilot adds account/post reservations, an Apify adapter, durable polling and GHL tag reconciliation. See [LIKES.md](./LIKES.md) for the single-reel pilot and [LIKE-BATCHES.md](./LIKE-BATCHES.md) for GHL-driven sessions, automatic post selection, shared activity limits, recovery and attention reports. Batch discovery/execution are independently disabled by default. Follow/comment/DM workflows are not enabled by this pilot.


