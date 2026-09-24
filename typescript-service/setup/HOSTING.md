# Outreach hosting setup

Updated 2026-09-16. Hosting is on the user-selected Develop Coaching team.

- Project: develop-coaching/peakspan-pt-outreach
- Project ID: prj_q3pegcQiBfDXCs3w4nXEEVL7LpLt
- Team ID: team_xEgKSwCNdqqeHCoTuawPAuY9
- URL: https://peakspan-pt-outreach.vercel.app
- Linked deployment directory: typescript-service/ only. Never deploy the legacy repository root.
- Framework: Next.js, explicitly selected in vercel.json; Node 24.x.
- Database: user-created Neon resource neon-red-book, verified connected in Production only. No duplicate resource was provisioned. Plan/region have not been independently verified.
- First deployment passed health but failed readiness because core authentication variables were missing.

## Private configuration

Production contains database credentials, GHL_API_TOKEN, APIFY_API_TOKEN, and IG_LIKE_COOKIES_JSON as sensitive secrets. IG_LIKE_ACCOUNT_ID is Production-only configuration. Admin and cron secrets were generated securely and saved as Production secrets. Slack and GHL webhook secrets are not consumed by implemented routes and no longer block the core schema; future webhook implementations must validate their own real secrets.

Vercel does not export sensitive Production values. A pull to .env.hosted-check.local yields [SENSITIVE] placeholders, which must never be used as credentials. .env.operator.local holds generated operator secrets for authenticated verification. Both files, .env.local, and .vercel/ are ignored; never print or commit them. Use fresh original JSON directly in Vercel, not chat-formatted or exposed cookie exports.

## Disabled defaults

OUTREACH_EMERGENCY_DISABLED=true; IG_LIKE_ENABLED=false; MONITORING_ENABLED=false; MONITORING_ALERTS_ENABLED=false. No schedules are configured. The single target remains account ashley_and_ashley.peakspan, target tkofitness, contact 4sBTiGuhiUM4rBOPKN5i, location IrowzqVtMrN5qsb5iMLQ, reel https://www.instagram.com/reel/Dc-QNOzTIN8/.

## Explicit database bootstrap

Ordinary builds do not connect to the database. The build script runs migrations only when OUTREACH_BOOTSTRAP_DATABASE=true is explicitly supplied to a Vercel Production build with all four disabled flags verified. Use the existing linked project:

    vercel deploy --prod --yes --scope develop-coaching --build-env OUTREACH_BOOTSTRAP_DATABASE=true

The script uses the hosted unpooled connection, serializes bootstrap builds with a session advisory lock, rejects unrelated public tables, applies checked-in Drizzle migrations, verifies all ten service tables, and initializes the like switch as disabled. It never enables an existing switch or contacts an outbound provider. Failure stops deployment and emits a sanitized message. The bootstrap flag is a per-deployment build override, not a saved project variable. Future ordinary deployments omit it.

## Verification and remaining boundary

GET /api/health checks hosting; GET /api/ready checks database connectivity through validated core configuration. Admin-authenticated GET /api/admin/instagram/preflight performs read-only checks of the configured pilot: cookie syntax/account-ID consistency, GHL contact eligibility, local suppression, and both write gates. It exposes no cookie/token/contact payload. Cookie consistency is not proof of a live Instagram session or username ownership, and token presence is not Apify authentication validation.

After bootstrap deployment, verify health/readiness, unauthorized admin rejection, authenticated disabled start/reconcile behavior, and read-only preflight. Record actual results in the operator report; local tests alone are not hosted verification. Resolve any remaining identity or eligibility issue before the separately approved single-reel canary. Database bootstrap does not authorize a live like, follow, message, or monitoring action.

