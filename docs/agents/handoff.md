# Handoff (2026-11-11, afternoon lead session, 12:00 to 13:50 UTC)

## 1. State

- **main** `ba614c8` (#80 merged after #79 at 13:13Z by Myles, by hand). CI on both merge
  commits was in progress at 13:15Z; the previous head 682b500 was green on both jobs.
- **Open PRs**
  - **#82** (AI-629, `auto-merge` on the issue, branch `AI-629-to-main`): carries PR #81's two
    Peloton-probe commits (bearer token, `joins` fix) that were stranded on `AI-627-probes`.
    Touches `scripts/probes/README.md` and `scripts/probes/peloton-probe.sh` only. Lead-opened.
  - **This docs PR** (AI-634, `auto-merge`, branch `AI-634-docs`): decision log, this handoff,
    profile corrections, `scripts/probes/garmin-probe.sh` closing message (spec is committed).
- **Epic AI-627** (Backlog, no `needs-input`): 16 decisions recorded in its description; the
  probe captures are attached (two zips) with findings comments by Myles's session and the
  lead's payload-facts write-up (full document as a comment, 13:14Z; not committed because it
  describes Myles's own data and the repo is public).
- **Wave 1 filed 13:11Z; the runner took all three within minutes.**
  - AI-632 maths module: PR #85 merged 13:28Z (monitor), **Done**; post-merge verification
    passed all 17 must-dos, no follow-up.
  - AI-633 FIT decoder: PR #86 merged, **Done**; verification passed, no follow-up.
  - AI-631 schema + DataLayer: **PR #84, draft, Myles merges** (migration). `/code-review
    high` found ten findings; eight fixed in 8e75802 (parent-ownership RLS on streams and
    pairing, double precision streams, moddatetime trigger, real replace semantics, payload
    guard, mock FK and timestamp checks), CI green. Review brief posted on the PR 13:47Z.
    After merge: AI-631 Done if the monitor lags, then file wave 2.
- **Monitor behaviour today:** it merged the runner's PRs (#85, #86) and moved their issues
  to Done, but did not merge the lead-opened #79, #82 or #83 (green, CLEAN, `auto-merge` on
  AI-628/AI-629/AI-634). Myles merged #79 and #80 by hand; #82 and #83 await him or a
  monitor fix. The profile's "#66 merged four minutes after" fact may no longer hold.
- **AI-628** Done by hand 13:34Z (PR #79 merged by Myles 13:13Z; monitor had not moved it). **AI-629** (In Progress, `auto-merge`):
  Done once #82 merges. **AI-634**: Done once this PR merges.
- Wave 2 (Garmin sync, Peloton sync with refresh tokens, CLI backfill, Strava gap import),
  wave 3 (screens, MCP tools) and wave 4 (cron, env) are not filed. File wave 2 when #84 is
  merged; its briefs must read the payload-facts comment on AI-627 (section 12,
  deltas) and decisions 14 and 16.

### Facts learned this session

- Probe results (Myles ran both scripts): Garmin Personal API works end to end (17 GETs, FIT
  download). Garmin has **no heart rate** for Myles's account anywhere (list, FIT, dailies,
  sleep); 9 of 20 recent rides carry power and Garmin's own NP/TSS/IF in the list item; weight
  is in grams. Peloton password login is retired (403); an Auth0 bearer token (48 h,
  `offline_access`) works; workout detail accepts only `joins=ride,ride.instructor,user`;
  `workout_history_csv` gives 753 summary rows without ids. Full detail: payload-facts comment
  on AI-627 and `docs/reference/garmin-personal-api-openapi.json` (PR #80).
- `@garmin/fitsdk`'s licence forbids redistribution; AI-633 hand-writes the decoder.
- The monitor did not merge #79 or #80 in 9 h (branches named `AI-627-*`, label on AI-628 or
  none); Myles merged by hand. Key unverified; lead branches are now named for the labelled
  issue. A PR based on another open PR's branch (#81 on #79) stranded its commits.
- Myles answered the planning page's nine decisions one by one (decisions 5 to 13), then
  Peloton sync auth = token pair + refresh (14), wait for probes before wave 1 (15), flat
  55 TSS/h for rides with neither power nor HR (16).

## 2. Questions for Myles

None blocking. Still on his list from the morning page: request the Strava archive before the
subscription ends; rotate the Garmin key pasted in chat (never used, never recorded); put the
new key in Vercel env; FTP and threshold HR can now come from Peloton `/api/me` and the FTP
test on 2026-11-10, so no manual entry is needed unless he prefers one.

## 3. For the host

Remove scratch worktrees `wt-lead4`, `wt-lead5`, `wt-verify85`, `wt-verify86` and `wt-fix84`
under the scratchpad directory, plus the earlier ones listed in the profile.
Branch `AI-627-probes` can be deleted once #82 merges.
