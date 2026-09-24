# Single-like provider setup

Prepared on 2026-09-09. This is a manual provider test setup, not an implemented TypeScript like workflow. No actor has been started and no service switch has been enabled.

## Confirmed test details

| Setting | Value |
| --- | --- |
| Actor | `dead00/instagram-like-bot` |
| Account performing the like | `ashley_and_ashley.peakspan` |
| Intended post owner | `tkofitness` |
| Post/reel URL | `https://www.instagram.com/reel/DdCuvFOx6S4/` (user supplied; tracking parameters removed) |
| Maximum likes | `1` |
| Delay setting | `30` seconds; not a guarantee against account restrictions |

The account name is an operator check, not an actor input field. The cookies determine which Instagram account acts. A post URL does not prove its owner; confirm the selected post belongs to `tkofitness` before running.

## Enter the private information directly in Apify

1. Open https://apify.com/dead00/instagram-like-bot and use **Try for free** to reach the actor in your own Apify account. Review the actor's current charges in the console before starting anything. No subscription or purchase has been made by this setup.
2. In Instagram, confirm you are logged in as `ashley_and_ashley.peakspan`. The actor documents a browser cookie JSON export as its authentication method. Export only Instagram cookies using a cookie-export tool you trust. Cookies grant account access; provide them only directly to the chosen actor's **Instagram Cookies** field, not to this repository or chat. Running this third-party actor gives its code access to those cookies. Its retention claims have not been independently verified.
3. Replace the entire prefilled cookie array. Do not reuse the public example's cookie values. Replace all sample post URLs as well.
4. Set **Post / Reel URLs** to exactly one confirmed `tkofitness` post/reel link, **Max Likes Per Run** to `1`, and **Delay Between Likes** to `30`.
5. Leave optional proxy configuration unset for now. No proxy purchase or working proxy setup has been verified.
6. Stop before **Start** and tell Codex that the input is ready. The next step is the single live test; this document has not performed it. Do not share screenshots containing cookies.

The adjacent `instagram-like-input.example.json` contains the selected reel and an intentionally empty cookie array. In Apify's JSON input editor, replace that empty array there with your private cookie array. Do not fill secrets into the tracked example file. Apify console testing does not require putting an Apify API token into this JSON.

If a local private copy is ever needed, use a filename ending in `.local.json`, which is already ignored by this repository. Git ignore is not encryption. Prefer entering the cookie array directly in Apify for this first setup.

## Verify the first result before any further run

Record the run ID, target URL and sanitized dataset status. The documented dataset fields are `url`, `status`, `message` and `timestamp`. Require a row matching the exact selected post with `status: success`, then check that the like appears from the intended account in Instagram. A green actor run alone is insufficient.

Documented other statuses are `failed`, `blocked`, `rate_limited` and `auth_error`. Stop on any of these. Missing, inconsistent or uncertain output also needs inspection; do not automatically rerun. One-like-per-run is not deduplication across repeated runs, and the manual console bypasses the TypeScript service's kill switches and action ledger.

## Service integration remains separate

The service now contains a default-disabled like adapter, authenticated routes, durable workflow and like-specific action switch. See [LIKES.md](../LIKES.md) for service configuration and launch prerequisites. This manual console procedure remains outside those controls. Do not change outreach or monitoring flags for this console test. A follow provider has not been selected.

For API integration, put a newly rotated Apify API token and fresh `IG_LIKE_COOKIES_JSON` into the private server environment or deployment secret store, never this example or chat. Instagram cookies are actor input, not an Apify API token. Other required pilot settings and identity checks are documented in LIKES.md.

## Sources checked

- Actor README and output contract: https://apify.com/dead00/instagram-like-bot
- Actor input fields: https://apify.com/dead00/instagram-like-bot/input-schema

The public README and input schema disagree on the upper maximum-like limit. This test uses `1`, supported by both. Provider documentation was inspected; authenticated account access and actual provider behavior have not been tested.

