# Instagram like pilot

The TypeScript service now implements a manually triggered, single-post like workflow for `dead00/instagram-like-bot`. It remains disabled and has not been deployed or executed against live providers. No recurring like schedule is registered.

## Manual provider evidence

On 2026-09-09, the user ran the actor in Apify for reel `DdCuvFOx6S4`. Their screenshot showed one matching `success` dataset row and a reported run cost of $0.008. The user confirmed the reel was liked from `ashley_and_ashley.peakspan`, but reported an older like timestamp. This demonstrates the observed liked state and the actor's success response, not proof of a newly created like. The console run is outside this service's action ledger. Use a fresh unliked post for the service canary.

## Configuration before a service canary

On 2026-09-14 the user selected reel `Dc-QNOzTIN8` and supplied the existing GHL contact link. The non-secret template now records location `IrowzqVtMrN5qsb5iMLQ`, contact `4sBTiGuhiUM4rBOPKN5i`, and canonical post URL `https://www.instagram.com/reel/Dc-QNOzTIN8/`. The original link included the `tkofitness` profile prefix. These are user-supplied identifiers, not evidence of a live GHL eligibility check. The selected request is saved in [setup/instagram-like-service-request.example.json](./setup/instagram-like-service-request.example.json); it has not been submitted. The older Apify input example remains a record of the separate manual test.

Set replacements only in the private server environment or deployment secret store. `.env.example` contains placeholders; do not put secrets in it. Cookies are loaded inside the actor-start step and are never workflow arguments, step outputs, API responses or database result fields. The chosen third-party Apify actor necessarily receives them in its run input.

| Variable | Required value / responsibility |
| --- | --- |
| `IG_LIKE_ACCOUNT_USERNAME` | `ashley_and_ashley.peakspan` |
| `IG_LIKE_ACCOUNT_ID` | Numeric Instagram account ID, independently verified by the operator to belong to that username |
| `IG_LIKE_COOKIES_JSON` | Fresh, flat Instagram cookie JSON array for that account; must include `sessionid`, `csrftoken`, `ds_user_id` |
| `IG_LIKE_TARGET_USERNAME` | `tkofitness` for this pilot |
| `IG_LIKE_CONTACT_ID` | `4sBTiGuhiUM4rBOPKN5i`, supplied by the user for the target |
| `IG_LIKE_POST_URL` | `https://www.instagram.com/reel/Dc-QNOzTIN8/`, supplied by the user for the service canary |
| `APIFY_API_TOKEN` | Rotated private Apify token for the operator's account |
| `GHL_API_TOKEN`, `GHL_LOCATION_ID` | Verified GHL account configuration |

The credential validator rejects nested arrays, duplicate cookie names, missing essential cookies, foreign cookie domains, explicitly expired essential cookies, and an account mismatch in either `ds_user_id` or the numeric prefix of `sessionid`. A changed Instagram session format is denied until inspected. This checks cookie consistency with the configured numeric account ID; it does not independently resolve that ID to a username or validate login remotely. Likewise, the target username, GHL contact and post-owner mapping are operator-verified configuration, not an automatic ownership check.

The GHL contact must still be qualified, free of campaign stop tags, and not locally suppressed immediately before the actor start. No autonomous qualification or contact creation is added. An opt-out or reply that has not yet reached GHL/local suppression cannot be detected by this pilot; verify target state manually until live ingestion is connected.

## Controls

All three controls must allow writes:

1. `IG_LIKE_ENABLED=true` (defaults false).
2. `OUTREACH_EMERGENCY_DISABLED=false` and `VERCEL_ENV=production`.
3. Database setting `outbound_disabled:like` explicitly has `disabled: false`. A missing or malformed switch denies writes. The existing authenticated `/api/admin/kill-switch` endpoint now accepts action `like`.

These are prerequisites, not instructions to enable them now. Current files retain the emergency stop and all live operation defaults. Preview cannot start a like or add the GHL success tag. Setting the emergency stop or the database like switch blocks future actor starts and CRM writes, but does not cancel an actor already submitted to Apify. Existing provider-run observations may continue read-only while `IG_LIKE_ENABLED=true`. Setting that flag false stops even observation steps and can leave a reserved/active row for inspection.

Authentication failures at actor start, or terminal dataset `auth_error`, `blocked` or `rate_limited` results, atomically pause the action and disable the persistent like switch. Re-enabling that switch is an operator action after resolving the cause. No automatic circuit reset exists.

## Authenticated API

All routes require `Authorization: Bearer <ADMIN_API_TOKEN>`. The cron secret does not authorize them. Never include cookies in a request body.

`POST /api/admin/instagram/like`

```json
{
  "contactId": "4sBTiGuhiUM4rBOPKN5i",
  "postUrl": "https://www.instagram.com/reel/Dc-QNOzTIN8/"
}
```

Only the configured contact/post pair is accepted. Extra fields, profile URLs, non-Instagram URLs and credential-bearing URLs are rejected. Tracking parameters are removed. `/p/`, `/reel/` and `/reels/` aliases share the same account/shortcode reservation. One request starts at most one actor with one URL, `maxLikesPerRun: 1`, and delay 30 seconds.

Response: `accepted` (202), `duplicate` (200), `disabled` (200), authorization/validation error, or `dispatch_unknown` (503). Accepted means dispatched, not liked. Save the returned request ID. Retrying the same account/post pair cannot release or recreate its reservation, even after a failure. The allowlist is one configured post at a time, not a fleet-wide daily quota; do not broaden this into an unattended campaign without rate/budget controls.

`GET /api/admin/instagram/like?id=<request UUID>`

Returns only the action's safe state, provider reference/status, reason code and known cost. States are `reserved`, `starting`, `polling`, `provider_succeeded`, `succeeded` or `paused`. The database `action_attempts.result` holds the immutable target, phase, workflow link and sanitized provider status. Existing daily execution reports include these like actions and their known costs. No migration is needed beyond existing tables.

`POST /api/admin/instagram/like/reconcile`

```json
{ "id": "EXISTING_REQUEST_UUID" }
```

This starts a reconciliation-only workflow for an existing known provider reference. It cannot call the actor-start operation. It can poll the same run again or retry an additive GHL tag after confirmed provider success. An uncertain reconciliation dispatch can create duplicate observation workflows if manually repeated, but neither can start another like and the CRM tag operation is idempotent.

## Durability and result meaning

The database reserves the account ID plus post shortcode before Workflow dispatch, and atomically claims `reserved -> starting` before actor submission. A concurrent worker cannot start the same like. A crash while starting, or a lost response before recording the provider run ID, is ambiguous: leave the reservation intact and inspect Apify history manually. There is no automatic attachment of a guessed provider run, no reset-to-pending endpoint, and no claim of exactly-once network delivery. A stale `starting` row requires operator reconciliation even if the Workflow execution returned without an exception.

Polling uses durable 15-second sleeps, capped at 20 observations per workflow. Failed reads use the existing safe-read retry policy. A timeout pauses the action and preserves the run ID; it does not prove the actor stopped. Reconciliation reads only that stored run. Missing, duplicate, wrong-target or unrecognized dataset rows do not establish success.

A `SUCCEEDED` actor run plus exactly one matching dataset row with `status: success` records `provider_succeeded`. The adapter strips raw provider message text and does not infer a new-like timestamp. It then adds `ig-liked` to the matching GHL contact via the additive tags endpoint. This tag records a provider-reported liked state, not proof of a new like or completion of any follow/comment stage. A GHL failure preserves provider success; retrying reconciliation cannot repeat the Instagram action. Suppression does not erase historical success, but kill switches and configured-target identity still gate the CRM write.

Other dataset statuses pause the action. Unknown outcomes, even after a terminal actor failure, are retained for inspection rather than resubmission. Reconciliation does not automatically clear a tripped circuit.

## Verification and launch prerequisites

Synthetic tests cover account/URL validation, provider input/result contracts, disabled and authenticated HTTP boundaries, concurrent SQL reservations and actor-start claims, uncertain dispatch/start, GHL-only retries, circuit breaking, suppression and timeout reconciliation. Database tests use PGlite. The real Workflow integration test exercises only default-disabled start/reconciliation; it does not claim hosted DB/provider coverage.

Before live service operation: rotate the Instagram session exposed in the earlier screenshot and other exposed project credentials; verify the secret configuration and account/contact/post mapping; provision and verify hosted Postgres; deploy disabled; validate real account API contracts; then enable only the like pilot and run one fresh post. No such deployment or service canary has happened in this implementation. Likes do not enable follows, comments, DMs or schedules.

Provider sources: [README and output contract](https://apify.com/dead00/instagram-like-bot), [input schema](https://apify.com/dead00/instagram-like-bot/input-schema), checked 2026-09-09. The static documentation and manual observation are evidence, not a provider reliability guarantee.

