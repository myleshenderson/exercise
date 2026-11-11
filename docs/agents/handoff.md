# Handoff (2026-11-11, evening lead session, 18:30 to 21:45 UTC)

## 1. State

- **main** green (test + migrate) at 7ce722c. **No open PRs.** Two migrations are applied in
  production: `20261111131256_ride_analytics.sql` (15:04Z) and
  `20261111195714_sessions_service_role_select.sql` (grant for the sync's `service_role`
  read of `sessions`, 591f404, ~20:05Z).
- **Epic AI-627 (ride analytics): waves 1, 2 and 3 are all merged.** Gates AI-644 (wave 2)
  and AI-656 (wave 3) closed 21:40Z. Production now has the seven ride screens, the Home
  "This week" strip, the sync runner with its daily cron (first run 10:00Z 2026-11-12), the
  owner `POST /api/sync` path, the Strava archive importer and 32 MCP tools (25 + 7 ride).
- **New standing rule (Myles, ~19:50Z): the lead reviews and merges production-path PRs,
  migrations included.** "i don't want to review things" and, on a proposed migration
  exception, "i want you to make good decisions". Recorded in the decision log and the
  profile; applied to #94, #95, #101, #102, #106.
- **Merged this session, all verified by a subagent against their ACs:** #92 AI-641 runner
  (plus the lead's `scripts/set-sync-env.sh`, added at Myles's request), #94 AI-653 owner
  sync endpoint (recompute resumes via `offset`/`nextOffset`), #95 AI-655 paging, #96
  AI-645 FIT offset, #97 AI-660 readable sync errors, #98 AI-649 UI foundation, #99 AI-648
  typecheck scripts, #100 AI-640 Strava import, #101 AI-664 grant migration, #102 AI-661
  strength-app paging, #103 AI-651 My Stats + Training, #104 AI-650 feed + detail, #105
  AI-652 Power/Weight/Settings, #106 AI-654 MCP ride tools. Review findings that did not
  block a merge became the follow-up issues below.
- **Owner backfill (AI-642) ran from Myles's machine.** Vercel env vars set with the script.
  Garmin: 535 rides, 1091 weigh-ins, `done true`. Peloton: 486 rides, cursor written 19:43Z
  (summary line not seen by the lead). The closing daily-load recompute failed with Postgres
  42501 on `sessions` (fixed by AI-664). **The recompute has not been confirmed:** Myles was
  asked to run `npm run sync -- --source peloton --incremental --recompute-all` from an
  updated main and paste the two summary lines. Until it runs, `daily_training_load` is
  empty and Training/Home strip show no load.
- **Stills:** none rendered this session. The agent container lacks Chromium's system
  libraries and cannot install them; AI-666 (worktree-tools) asks for them in the image.
  Myles sees the deployed app instead.
- **CI incident:** six Actions runs queued without jobs from 20:22Z for ~50 min; `ci.yml` has
  no `workflow_dispatch`; fixed with fresh commits on the three affected branches (profile).

## 2. Queue

- **AI-670 (urgent, `auto-execute` + `auto-merge`, Todo, unclaimed at 21:45Z):** the Starkeep
  `activity_stats` parity test compares `as_of` with the UTC date; main's `test` job goes
  red between 00:00Z and 05:00Z every night until it lands. If the dispatcher has not
  claimed it by ~23:00Z, Myles can run the one-file fix by hand (the issue has exact text).
- **AI-669 (`auto-execute` + `auto-merge`, Todo):** Settings shows sync controls only when the
  account has `sync_state` rows; estimated-TSS help text. Unblocked (AI-652 Done).
- **AI-667 (Todo, unlabelled, production path):** bounded queries for `getLastSetsForExercise`,
  `listSessions`, `getExerciseHistory` (replaces the per-session N+1). Label when the
  strength app's load times matter; lead reviews before `auto-merge`.
- **Owner-run:** AI-642 (recompute result pending, then size check), AI-643 (Strava gap
  import; needs the Strava archive), Garmin key rotation (the pasted key), Peloton summary
  line.
- **Backlog, runner-filed, untriaged:** AI-659 (serialise sync runs vs. cron), AI-662
  (typecheck `check-migration-versions.mjs`), AI-663 (share CSV parser, move
  `fitStartOffsetS`), AI-665 (remaining unpaged strength reads), AI-668 (Peloton instructor
  column). Triage next session; none is urgent.
- **worktree-tools (Myles's):** AI-636 (document the monitor's lead-PR rule), AI-666
  (Chromium libraries in the agent image).
- **Starkeep epic AI-386:** parked on owner-run AI-595, AI-596, AI-597, AI-598.

## 3. Questions for Myles

1. Paste the two lines from `npm run sync -- --source peloton --incremental --recompute-all`
   (AI-642). If `recompute-all` reports activities and days, the daily load is live.
2. Did Peloton's `--full` run print `done true` at 486 rides? The CSV's 753 rows include
   non-ride workouts, so 486 is plausible, but the lead never saw the line.
3. Garmin key rotation: confirm the rotated key is the one in `.env.local` and Vercel.
4. AI-670 timing (above): hand-merge if the dispatcher is idle before midnight UTC.

## 4. Scratch worktrees to remove on the host

`wt-lead4`, `wt-lead5`, `wt-lead6`, `wt-lead7`, `wt-ci635`, `wt-verify85`, `wt-verify86`,
`wt-verify88`, `wt-verify89`, `wt-verify90`, `wt-verify91`, `wt-verify92`, `wt-verify94`,
`wt-verify96`, `wt-verify98`, `wt-verify100`, `wt-verify103`, `wt-verify104`, `wt-verify105`,
`wt-verify106`, `wt-fix84`, `wt-fix92`, `wt-fix94`, `wt-fix95`, `wt-fix100`, `wt-fix102`,
`wt-fix106`, `wt-merge92`, `wt-env92`, `wt-c6`, `wt-briefs`, `wt-rebase105` (all under the
session scratchpad). Branch `AI-627-probes` and the merged `AI-nnn` branches can be deleted.

## 5. Next session

Start with the session checklist, then: read AI-642's result; triage the five Backlog
issues; label AI-667 if wanted; check AI-669/AI-670 merged and verified; consider adding
`workflow_dispatch` to `ci.yml` (lead-filed issue) so a stuck run can be re-triggered
without a commit; update `project-memory.md` "Ride sync" if the recompute surfaced
anything. The epic AI-627 stays open until AI-642 and AI-643 are done.
