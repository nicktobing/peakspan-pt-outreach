# Follow, comment and DM stages

These stages share the Instagram account lock and rolling 24-hour attempted-action budget with likes. A contact/action claim is permanent, provider starts are never retried after an uncertain response, and GHL success tags are added only after one exact provider dataset record confirms the requested action.

An unfinished like-batch session owns the acting account even while it is between items, so manual follow/comment/DM claims are rejected until that session finishes or is cancelled. A private-account follow request is recorded as `provider_requested` and paused; it is not tagged `ig-followed` and cannot unlock commenting.

All stages are independently disabled by default:

- `IG_FOLLOW_ENABLED`
- `IG_COMMENT_ENABLED`
- `IG_DM_ENABLED`
- the matching persistent kill switch (`follow`, `comment`, or `dm`)
- the global emergency switch and production-only gate

DM delivery additionally requires `IG_DM_PROVIDER_VALIDATED=true`. Drafting and approval use `IG_DM_DRAFTS_ENABLED` and do not authorize delivery. An approved snapshot is immutable; the sender must match the exact contact, username and text in that snapshot, and eligibility/suppression is checked again immediately before the actor starts.

Manual canaries use `POST /api/admin/instagram/engagement`. Supported actions are `follow`, `comment_1`, `comment_2`, `comment_3`, and `dm`. Status is read with `GET /api/admin/instagram/engagement?id=<action-id>`. A known provider run can be observed or its GHL tag reconciled through `POST /api/admin/instagram/engagement/reconcile`; reconciliation never starts another Instagram action.

A comment can only target the exact post already confirmed as liked for that contact, username, and acting account. This prevents an admin request from commenting on an unrelated post. A later scheduled comment batch must add its own verified post-discovery claim before it can use a different post.

DM approval batches use `POST /api/admin/instagram/dm-approvals` with either `operation: create` and one to ten draft items, or `operation: decide` with an approval ID. This endpoint is admin-authenticated. DM text must identify PeakSpan, use affiliate or referral framing, contain no link or blocked claim, and remain within 100 words.

No follow, comment, or DM schedule is installed by this change. Start with a single contact for each stage, verify the Instagram result and GHL tag, then decide whether to add a bounded batch schedule.

