# Handoff (2026-11-11, late lead session, 21:52 to ~22:45 UTC)

## 1. State

- **main** green (test + migrate) at the #114 merge. Three migrations are applied in production:
  `20261111131256_ride_analytics.sql`, `20261111195714_sessions_service_role_select.sql` and
  `20261111221500_sync_lock.sql` (22:37Z, lease row + `acquire_sync_lock` / `renew_sync_lock`).
- **Epic AI-627:** all waves merged. Owner backfill complete: `recompute-all: 1021 activities,
  3504 days` (535 Garmin + 486 Peloton), so daily training load is live. Remaining owner-run:
  AI-642 stream-size check, AI-643 Strava gap import. AI-668 Canceled (Myles: no).
- **Merged this session, all verified on main by a subagent:** #108 AI-670 parity-test UTC date,
  #109 AI-669 owner-only sync controls, #110 AI-662 script tests typechecked, #111 AI-663 shared
  CSV parser, #112 AI-672 four ride-screen visual fixes (from the lead's stills), #113 AI-673 Sync
  card hidden for non-owners, #114 AI-659 sync lease (reviewed at high, seven findings fixed).
- **#115 (AI-667, bounded strength-app reads) merged 23:38Z** by the monitor on Myles's call ("just
  merge it if it sucks we can fix it"); main green on 7f32363. Myles checks Home, Logged workouts, an
  exercise History and a Session's last sets in production; a failure is a one-PR revert. Post-merge
  verification on main was run by the lead: see AI-667 comments.
- **Queue:** AI-674 (coverage excludes `*.py`/`*.sh`, low, labelled). Nothing else ready.
- **Stills work now.** AI-666/AI-275 added Chromium's libraries to the image. Playwright's
  headless-shell download is blocked, so `npm run screenshots -- --rides` needs the full Chromium
  (`npx playwright install chromium` works) symlinked at the headless-shell path; see the profile.
  Ten ride-screen stills from main and from branch AI-672 are in the session scratchpad only.

## 2. Questions for Myles

1. Still open from earlier: Peloton `--full` `done true` at 486 rides.
2. AI-642 stream-size check (owner-run).

## 3. For the host

Remove scratch worktrees under the session scratchpad: `wt-stills`, `wt-stills112`, `wt-verify108`,
`wt-verify110`, `wt-verify112`, `wt-verify114`, `wt-fix114`, `wt-fix115`, `wt-docs676`, `wt-verify115`, plus the earlier ones listed
in the profile. Merged `AI-nnn` branches can be deleted.

## 4. Next session

Session checklist first. Then: confirm AI-667 Done and Myles's production check; if a strength
screen is empty, revert #115; confirm AI-674 merged; check the 10:00Z 2026-11-12 cron run
(`sync_lock` row released, `sync_state` cursors advanced, no 409 in the Vercel log); triage anything
runner-filed; update the epic. Consider a lead-filed issue to add `workflow_dispatch` to `ci.yml`
(still not done).
