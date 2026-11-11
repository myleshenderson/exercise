# Handoff (2026-11-11, late lead session, 21:52 to ~22:45 UTC)

## 1. State

- **main** green (test + migrate) at the #114 merge. Three migrations are applied in production:
  `20261111131256_ride_analytics.sql`, `20261111195714_sessions_service_role_select.sql` and
  `20261111221500_sync_lock.sql` (22:37Z, lease row + `acquire_sync_lock` / `renew_sync_lock`).
- **Epic AI-627:** all waves merged. Owner backfill complete: `recompute-all: 1021 activities,
  3504 days` (535 Garmin + 486 Peloton), so daily training load is live. Remaining owner-run:
  AI-642 stream-size check, AI-643 Strava gap import. AI-668 (Peloton instructor column, a feature
  with a migration and backfill) sits in Backlog until Myles wants it.
- **Merged this session, all verified on main by a subagent:** #108 AI-670 parity-test UTC date,
  #109 AI-669 owner-only sync controls, #110 AI-662 script tests typechecked, #111 AI-663 shared
  CSV parser, #112 AI-672 four ride-screen visual fixes (from the lead's stills), #113 AI-673 Sync
  card hidden for non-owners, #114 AI-659 sync lease (reviewed at high, seven findings fixed).
- **Open PR #115 (AI-667, bounded strength-app reads):** reviewed at medium, eight findings fixed in
  c74f43a, CI green, CLEAN, no merge label. **Waiting on Myles's smoke test of the Vercel preview**
  https://exercise-git-ai-667-myles-projects-f73f7b28.vercel.app (Home day list, Logged workouts, an
  exercise History, a Session's last sets): the aliased `probe` inner embed and `session_sets.limit=1`
  are only checked against the stub. On "preview fine": add `auto-merge` to AI-667. If a screen is
  wrong: brief a fix agent on branch `AI-667`.
- **Queue:** AI-674 (coverage excludes `*.py`/`*.sh`, low, labelled). Nothing else ready.
- **Stills work now.** AI-666/AI-275 added Chromium's libraries to the image. Playwright's
  headless-shell download is blocked, so `npm run screenshots -- --rides` needs the full Chromium
  (`npx playwright install chromium` works) symlinked at the headless-shell path; see the profile.
  Ten ride-screen stills from main and from branch AI-672 are in the session scratchpad only.

## 2. Questions for Myles

1. #115 preview smoke test (above). One minute; reply "preview fine" or name the screen.
2. AI-668 Peloton instructor column: want it? If yes the lead pins and dispatches it.
3. Still open from earlier: Peloton `--full` `done true` at 486 rides; the Garmin key rotation.

## 3. For the host

Remove scratch worktrees under the session scratchpad: `wt-stills`, `wt-stills112`, `wt-verify108`,
`wt-verify110`, `wt-verify112`, `wt-verify114`, `wt-fix114`, `wt-fix115`, plus the earlier ones listed
in the profile. Merged `AI-nnn` branches can be deleted.

## 4. Next session

Session checklist first. Then: resolve #115 (label or fix), verify it on main, close AI-667; confirm
AI-674 merged; check the 10:00Z 2026-11-12 cron run (`sync_lock` row released, `sync_state`
cursors advanced, no 409 in the Vercel log); triage anything runner-filed; update the epic. If
Myles wants AI-668, scope the migration + backfill before pinning. Consider a lead-filed issue to
add `workflow_dispatch` to `ci.yml` (still not done).
