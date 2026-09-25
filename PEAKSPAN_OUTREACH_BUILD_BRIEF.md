# PeakSpan PT Affiliate Outreach — Build Brief for Coding Agent

> **How to use this file:** Put it in the root of a new repo as `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code). Then tell the agent: *"Read AGENTS.md / CLAUDE.md and build milestone 1."* Build one milestone at a time. Review and test each one before moving on.

---

## 0. Instructions to the agent

- **The repo is already partially built. Before writing any code, audit it:** read the whole codebase and produce `AUDIT.md`. For every section and milestone of this brief, mark it Done / Partial / Missing / Conflicts with brief, with file references. Then propose a plan that reuses what exists. Don't rewrite working code just to match the suggested layout. Wait for approval of the plan before building.
- You are rebuilding an existing n8n automation as a maintainable codebase. **Don't port n8n node by node.** Section 8 explains how the old build worked and what went wrong; take the ideas and fix the mistakes.
- No n8n. No Zapier unless a step has no API (none currently needs it).
- Build in the milestone order in Section 11. Every milestone ends with passing tests and a short `CHANGELOG.md` entry.
- Never hardcode secrets, IDs or message copy in code. Secrets go in env vars. IDs go in `config/`. Copy goes in `templates/`.
- Instagram engagement and DMs run through Apify actors on the PeakSpan account (decided, see Section 3). Always go through the `Engager` / `Sender` interfaces and the health check.
- When unsure, pick the simpler option and write it down in `DECISIONS.md`.

---

## 1. Business context

PeakSpan is an Australian **doctor-led** metabolic health, longevity and body-composition program. We want Australian personal trainers (PTs) on Instagram and Facebook to become **referral affiliates**. They refer clients to a doctor consultation and earn a commission per referral.

The pipeline:

1. Discover PTs.
2. Qualify them with an LLM.
3. Send personalised first-touch outreach.
4. Manage everyone in the GoHighLevel (GHL) pipeline until they become an active affiliate.
5. Escalate only the exceptions to a human (Greg or a delegate).

**Pipeline stages (GHL):** `Identified → Outreach Sent → Responded → Interested → Affiliate Onboarded → Active Affiliate`, plus side stages `Escalation`, `Not Interested`, `No Response`, `Do Not Contact`, `Disqualified`.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript (Node 20+). Strict mode. |
| Web / API | Fastify (webhooks + a small admin UI) |
| DB | Postgres, with Prisma or Drizzle ORM. **Postgres is the source of truth; GHL is a mirror.** |
| Jobs / schedule | pg-boss (Postgres-backed queue + cron). No extra Redis. |
| Scraping | Apify via `apify-client` (public-data actors only, see Section 5) |
| LLM | Provider interface with OpenAI and Gemini implementations. Structured JSON output validated with Zod. |
| CRM | GHL API v2 (`services.leadconnectorhq.com`, header `Version: 2021-07-28`), Private Integration token |
| Email | Sent via GHL (Conversations API / workflows) from a dedicated outreach domain |
| Alerts | Slack incoming webhook |
| Hosting | Railway or Render (one web service + one worker + managed Postgres) |
| Tests | Vitest. External APIs mocked with recorded fixtures. |

### Suggested repo layout

```
/src
  /config        env loading (zod-validated), ghl ids, thresholds
  /db            schema, migrations
  /jobs          discover.ts, enrich.ts, qualify.ts, draft.ts, send.ts, followup.ts, report.ts
  /integrations  apify.ts, ghl.ts, llm/{index,openai,gemini}.ts, slack.ts
  /compliance    bannedTerms.ts, checker.ts, reviewerPrompt.ts
  /webhooks      ghlInbound.ts (replies, stage changes)
  /admin         send-queue UI, escalation view, kill switch
/templates       outreach + follow-up + FAQ copy (markdown/yaml, human-approved)
/prompts         qualify.md, draft.md, classifyReply.md, review.md
/tests           unit + fixture-based integration tests
AGENTS.md / CLAUDE.md, DECISIONS.md, CHANGELOG.md, .env.example
```

---

## 3. Hard constraints (don't design around these)

1. **Instagram automation: decided, with guardrails.** Follow, like, comment and DM run through Apify actors using the **PeakSpan Instagram account's** session (the owner has accepted the risk; recorded in `DECISIONS.md`). This breaks Meta's Terms and can get the account restricted, so the following are mandatory:
   - **Interfaces.** `Engager` (follow / like / comment) and `Sender` (implementations: `apifyDm` = default, `email`, `manualQueue` = fallback). Switching senders is a config change only.
   - **Daily caps, in config.**
     - Weeks 1–2: 10 DMs, 20 follows, 20 likes/comments per day.
     - After that, only if the health check has been clean for 14 days: maximum 20 DMs, 25 follows, 30 likes/comments.
     - Per lead: no more than 1 action per day.
   - **Pacing.** Actions only Mon–Fri 08:30–17:30 `Australia/Sydney`, spread across the window, with random 3–15 minute gaps between actions. Never burst a batch.
   - **Warm-up order per lead.** Follow → like + comment on a recent post → like + comment on another post (2–3 days apart) → DM 2–4 days after the last engagement. This mirrors the old 2B → 2C/2D/2E → 2F flow, as one parameterised job.
   - **Health check (`src/health/instagram.ts`).**
     - Before each batch, validate the session: a cheap test call or the actor's status.
     - After each run, inspect the actor status and output for signs of trouble: login required, challenge, action-blocked, "try again later", rate limit, or 2+ consecutive failures.
     - On any of these: **automatically pause all Engager + Sender jobs** (set `instagram_paused=true` in the DB), send a Slack alert with the reason and the fix steps, and don't retry.
     - Resuming is manual only, via an admin button after the cookie is refreshed.
     - A daily health summary goes to Slack.
   - **Session secret.** The IG session cookie lives only in an env var / secret store and is refreshed via the admin UI. It never goes in code or logs.
   - **Double-send protection.** Unique constraints and the message status machine prevent any lead from being followed, commented on or DMed twice.
2. **TGA advertising rules.** Most peptides and weight-loss medicines are prescription-only in Australia, and advertising them to the public is prohibited. Affiliates count as advertisers. So no generated or templated outreach may mention peptides, medicine names, or therapeutic/weight-loss outcomes. This is enforced in code (Section 7).
3. **Transparency.** Every message says who PeakSpan is and that this is a paid referral partnership. No messages or comments pretending to come from a random person.
4. **Spam Act 2003 (email).** Identify the sender, include a working unsubscribe, and honour opt-outs immediately.
5. **Kill switch.** One config flag (and one button in the admin UI) halts all sending and LLM drafting.

---

## 4. Environment variables (`.env.example`, no real values)

```
DATABASE_URL=
GHL_PRIVATE_TOKEN=
GHL_LOCATION_ID=
APIFY_TOKEN=
LLM_PROVIDER=openai            # or gemini
OPENAI_API_KEY=
GEMINI_API_KEY=
SLACK_WEBHOOK_URL=
ADMIN_BASIC_AUTH=              # user:pass for admin UI
SENDING_ENABLED=false          # kill switch; default OFF
IG_SESSION_COOKIE=             # PeakSpan IG session for Apify actors; refresh via admin
DM_SENDER=apifyDm              # apifyDm | manualQueue | email
FALLBACK_TO_QUEUE=true
```

Existing GHL IDs to put in `config/ghl.ts` (not secrets; verify they still exist via API on boot):

- Location: `KM3KkAQFgG3bByTZmWLL`
- Pipeline: `GJxH7CibePegFRJyBpcu`
- Stage "Qualified": `20f11a66-3d21-4123-8ece-5e505290364e`
- Stage "Disqualified": `1afadb9f-e958-42e8-9dbd-071277c2d6e6`
- Create any missing stages from Section 1 and store their IDs in config. Don't guess them.

> ⚠️ The old n8n exports contained live keys (GHL token, OpenAI key, Apify token, IG session). Treat those as compromised. Rotate them before this build goes live, and never copy anything from the old JSON files into the repo.

---

## 5. Data model (minimum)

- **lead**: id, platform (ig|fb), handle, profile_url, full_name, bio, followers, posts_count, last_post_at, city, state, email, website, engagement_rate, source_run_id, status, ghl_contact_id, ghl_opportunity_id, do_not_contact, created_at, updated_at. Unique on (platform, handle).
- **post**: lead_id, external_id, url, caption, posted_at, likes, comments, owned_by_lead (bool).
- **score**: lead_id, total, audience_fit, engagement_quality, positioning_fit, red_flags[], summary, model, prompt_version, created_at.
- **message**: lead_id, channel (email|ig_dm|fb_dm), kind (first_touch|followup_1|followup_2|reply), body, template_id, source_post_id, compliance_result (json), status (drafted|blocked|queued|sent|failed), sent_at, sent_by.
- **event**: an audit log of every state change, API call failure, LLM call (prompt hash, tokens, cost).
- **affiliate**: lead_id, ghl_affiliate_id, link, commission_plan, onboarded_at, first_referral_at.
- **run**: job name, started/finished, counts, cost_usd, errors.

State changes are written **only after confirmed success** (lesson from the old build).

---

## 6. Phases — functional spec

### Phase 1 — Discovery (weekly, Mon 02:00 AEST)
- Apify public actors: `apify/instagram-hashtag-scraper`, `apify/instagram-profile-scraper`, `apify/instagram-scraper` (posts), `apify/facebook-pages-scraper`. Confirm the actor IDs on the Apify store at build time.
- Seed inputs come from `config/discovery.yaml`: AU fitness hashtags (e.g. `#personaltrainersydney`, `#melbournept`, `#brisbanept`, `#perthpt`, `#adelaidept`, `#goldcoastpt`), and city location terms.
- There's a per-run profile cap and a monthly Apify budget cap in config. Abort and alert when the budget cap is hit.
- Dedupe on (platform, handle). Skip `do_not_contact` and anyone contacted in the last 180 days.

### Phase 1b — Enrichment + hard filters (code, no LLM)
- Pull the 10 most recent posts per profile.
- Keep the profile only if all of these hold:
  - PT keyword in the bio (personal trainer, PT, strength coach, fitness coach, S&C, sports performance, online coach);
  - an AU signal (city/state, +61, .com.au, "Australia", 🇦🇺);
  - followers between 500 and 100k (both in config);
  - at least 10 posts;
  - a post in the last 30 days.
- Reject brands, gyms and franchises using a keyword heuristic plus a later LLM flag.
- Extract a public email or website from the bio or link.

### Phase 2 — Qualification (LLM)
- Input: bio, the 10 post captions, engagement rate. Output: Zod-validated JSON `{ total, audience_fit, engagement_quality, positioning_fit, red_flags[], summary }`.
- Positioning fit means performance, body composition, longevity, metabolic health.
- Red flags: sells own peptides/supplements/"protocols", makes medical claims, audience appears under 18, controversial or unsafe content, not actually a PT.
- Routing:
  - total ≥ 70 with no red flags → `Identified` (ready);
  - 50–69 → tag `review-later`;
  - under 50, or any red flag → `Disqualified` with the reason.
- Thresholds live in config. Store `prompt_version` with every score.
- Upsert the GHL contact with proper **custom fields**, not notes (see Section 8). Create an opportunity in the pipeline.

### Phase 3 — Draft + send
- The LLM fills **slots only** in a human-approved template:
  - `opener`: references one real detail from one scraped post, max 20 words, and must return `source_post_id`;
  - `fit_line`: one sentence on why their clients fit.
- The offer paragraph, disclosure and CTA come from the template file verbatim.
- Every draft goes through the compliance checker (Section 7). If it fails, it regenerates once. If it fails again, the lead goes to `Escalation` and the message is never sent.
- **Email** (if an address was found): sent automatically via GHL, within a daily cap and during business hours AEST.
- **Engagement comments** are LLM-written, specific to the post, max 12 words, and come from PeakSpan's account. They reuse the old style rules. They don't pretend to be a random person, and they never pitch or mention products. They pass the banned-terms check.
- **IG DM**: sent via the active `Sender` (default `apifyDm`), inside the caps, pacing and health-check rules in Section 3.1. A lead moves to `Outreach Sent` only after the actor run is confirmed successful.
- **Fallback `manualQueue`** (admin page) shows the profile link, the referenced post, a "copy message" button and a "Mark sent" button. It's used automatically for the rest of the day when Instagram is paused, if `FALLBACK_TO_QUEUE=true`.

### Phase 4 — GHL pipeline + follow-ups
- Follow-up 1 at day 4 and follow-up 2 at day 10: automatic for email, via the queue for DMs. After that, the lead moves to `No Response`.
- Any inbound reply stops the sequences immediately.
- Opt-in flow:
  1. Create the affiliate in the GHL Affiliate Manager. If its API is insufficient, record it in `DECISIONS.md` and propose FirstPromoter or Rewardful.
  2. Generate a unique link.
  3. Send the onboarding pack from `templates/onboarding.md`, which includes an approved "what you can and can't say" guide.
  4. Move the lead to `Affiliate Onboarded`.
- First tracked referral → `Active Affiliate`. After 60 days with no referral, send a nudge.

### Phase 5 — Replies + escalation
- A GHL inbound message webhook passes each reply to the LLM classifier. It outputs one of `interested | faq | complex | not_interested | stop | risk`, plus a confidence score.
- `interested` / `faq`: auto-reply using **only** the text in `templates/faq.yaml`. A reply on IG/FB inside the 24h window may go through GHL's official integration.
- `complex`, `risk`, any medical question, or confidence below 0.8: move to `Escalation`, tag the lead, and post a Slack alert to Greg with the thread and the reason.
- `stop` / `not_interested`: `Do Not Contact` or `Not Interested`. Permanently excluded from discovery.

---

## 7. AI guardrails (must be implemented and tested)

1. **Prompts live in `/prompts`, versioned.** Low temperature (≤ 0.4). The model only sees the lead's own data and may only use facts present in it.
2. **Banned-terms blocker** in `compliance/bannedTerms.ts`. Matching is case-insensitive and handles plurals and common misspellings. Blocked terms include:
   - peptide(s) and any peptide or medicine name (BPC-157, TB-500, semaglutide, tirzepatide, Ozempic, Mounjaro, HGH, testosterone, TRT, etc.);
   - "weight loss", "lose X kg", "fat loss guaranteed", "cure", "treat", "heal", "clinically proven", "miracle", "TGA approved";
   - before/after, income guarantees.
3. **Structural checks**:
   - PeakSpan is named;
   - the referral/affiliate nature is stated;
   - `source_post_id` exists and its caption actually contains the referenced detail (fuzzy match);
   - length is ≤ 90 words for a DM;
   - at most one link; at most one emoji.
4. **LLM reviewer pass**: a second call using `prompts/review.md` returns `{ pass, reasons[] }`.
5. **Audit log**: store every prompt, output and check result.
6. **Test suite**: `tests/compliance.test.ts` with 30+ seeded bad drafts that must all be blocked, and 10 good drafts that must all pass. CI fails if any case regresses.

> All templates, FAQ answers and the onboarding pack must be signed off by PeakSpan's legal/medical lead against the TGA Advertising Code **before** `SENDING_ENABLED=true`.

---

## 8. Lessons from the old n8n build

The old flows were:

- **2A Qualify:** a GHL webhook, a regex pre-filter, then a gpt-4o-mini score. The threshold went from 70 to 60 between versions.
- **2B Batch Follow:** Apify `synk~instagram-auto-follow`, 13 per run, twice a day.
- **2C–2E Like + Comment rounds 1–3:** Apify scraper, GPT-written 10-word comment, then `mikolabs~ig-post-reel-comment-bot` and `dead00~instagram-like-bot`, with a 2-day gap between rounds.
- **2F DM:** 5 fixed templates sent via `rhymed_jellyfish~instagram-dm-automation-messages`, 20 per run.
- **All flows:** Slack alerts and a Google Sheet cost log.

**Keep / port the idea:**
- Cheap code pre-filter before any LLM call.
- The later qualification prompt's approach: accept broad fitness signals, and don't penalise a lack of health-specific content. Remove all "peptide" wording.
- Comment-style rules for the opener: avoid clichés (amazing, crushing it, love this…), max length, vary openers, react to the specific post.
- Post grouping: match scraped posts to the requested profile via `inputUrl`, prefer posts the lead owns, and skip a lead after 3 empty scrapes.
- The warm-up sequence (follow → 2 engagement rounds → DM) and the same Apify actors, **if they still work**:
  - `synk~instagram-auto-follow`
  - `mikolabs~ig-post-reel-comment-bot`
  - `dead00~instagram-like-bot`
  - `rhymed_jellyfish~instagram-dm-automation-messages`

  Wrap each one behind the interfaces, so a broken actor can be swapped out.
- Failure alerting with an actionable "what to do" line, and per-run cost tracking (now in Postgres, with a weekly Slack summary).
- Reuse the existing GHL pipeline and stage IDs.

**Don't repeat:**
- Secrets hardcoded in nodes, and duplicated across workflows.
- Running IG actors with no health check and at bursty volumes. The old flows ran up to 30 comments a batch, 3× a day, and 20 DMs per run. They kept retrying after "refresh IG cookies / action-block" failures instead of stopping.
- DM templates that pitched "peptides" (a TGA breach).
- AI comments written to "sound like a real person, never a brand" (deceptive).
- Lead data stored in GHL **notes** and parsed back with regex; the IG URL stored in the `website` field; state and dates stored as tags (`comment-1-date:…`, `noposts-count:…`). Use DB columns plus GHL custom fields.
- `catch (e) {}` everywhere, which hid failures. Every error must be logged, counted and alerted.
- Tagging `ig-followed` **before** the action ran. Only write state after success.
- Inconsistent GHL update fields (`pipelineStageId` vs `stageId`). Wrap GHL in one typed client.
- Fire-and-forget actor runs polled after fixed waits (15 min, 5 min). Use Apify webhooks or `actor.call()` with timeouts and retries.
- The same code copy-pasted across 2C, 2D and 2E. Use one parameterised job.
- Search capped at 100 contacts per page without pagination (partly fixed later). Paginate everything.

---

## 9. Non-functional requirements

- Idempotent jobs: re-running a job never double-sends or double-tags. Use unique constraints plus a message status machine.
- Retries with exponential backoff on 429/5xx, and respect GHL rate limits (about 100 requests per 10s).
- Structured JSON logs. Every run is written to the `run` table.
- Timezone: all schedules run in `Australia/Sydney`.
- Monthly spend caps for Apify and the LLM, enforced in code.
- Admin UI behind auth, containing: Send Queue, Escalations, Review-later list, Kill switch, and a weekly metrics page (discovered, qualified, sent, reply rate, onboarded, active, cost).

---

## 10. Success metrics

- 150+ qualified PTs per week.
- A reply rate of at least 10%.
- 20% or more of replies convert to onboarded affiliates.
- 25+ active affiliates by day 90.
- Zero account restrictions, zero compliance incidents, zero duplicate sends.

---

## 11. Milestones (build in order)

Target: about 3–4 weeks to soft launch and 5–6 weeks to the full system, **less wherever `AUDIT.md` shows work already done**.

0. **Audit (day 1):** produce `AUDIT.md` and a revised plan against this brief. No new code yet.
1. **Foundations:** repo, config/env validation, DB schema, typed GHL client (read pipeline and stages, upsert contact, custom fields), Slack alerts, kill switch. *Done when* a boot check confirms the GHL IDs and creates any missing stages and custom fields.
2. **Discovery + enrichment + filters:** Apify integration, dedupe, budget caps. *Done when* a dry run on 50 profiles lands clean leads in the DB.
3. **Qualification:** LLM provider interface, qualify prompt, routing, GHL sync. *Done when* a 20-lead human calibration sample agrees with the routing in 16 or more cases.
4. **Compliance engine + drafting:** templates, slot filling, banned terms, reviewer pass, test suite. *Done when* the compliance tests pass 100%.
5. **Engagement + sending:**
   - `Engager` and `Sender` (`apifyDm`, `email`, `manualQueue`);
   - caps, pacing and working hours;
   - the Instagram health check with auto-pause.

   *Done when* test runs against internal accounts succeed, and a simulated action-block pauses everything and fires the Slack alert.
6. **Follow-ups + reply handling + escalation.** *Done when* seeded replies route correctly for all 6 classes.
7. **Affiliate onboarding + tracking + metrics page.**
8. **Soft launch:** 50 real PTs with `SENDING_ENABLED=true`. Review the results, then scale.

---

## 12. Open decisions (record answers in `DECISIONS.md`)

1. ~~Social sending approach~~ **Decided:** Apify on the PeakSpan account, with low caps, AU working hours, a health check with auto-pause, and a swappable sender.
2. LLM provider: OpenAI or Gemini (both are supported through the interface; pick a default).
3. Follower range, currently 500 to 100k.
4. Commission model and amount. This needs legal review, because doctors and AHPRA rules are involved.
5. Affiliate tool: GHL Affiliate Manager or FirstPromoter/Rewardful.
6. Who works the daily Send Queue, and who backs up Greg on escalations.
7. Outreach sending domain and IG/FB account(s) used for DMs.
