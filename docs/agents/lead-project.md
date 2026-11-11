# Lead project profile: exercise

The `lead` skill (`.claude/skills/lead/SKILL.md`) is project-agnostic and reads this file
right after itself. Everything here is specific to the exercise repo; where this file and
the skill disagree, this file wins. Correct a fact in place when it changes (same PR as
the session-end docs). Sections follow `.claude/skills/lead/PROFILE-TEMPLATE.md`.

## Tracker

- Linear, workspace **CommsCenter**, team **AI** (key `AI`), project **exercise**
  (https://linear.app/comms-center/project/exercise-a6ac7e06809d). CLAUDE.md has the
  `linear` CLI cheat-sheet; always `--no-input --team AI --project exercise` (`issue create`
  fails without `--team` in the lead container despite `.linear.toml`), `--json`
  when parsing. `issue update` cannot combine `--state` with `--add-label` or
  `--remove-label` in one call (it answers "Move the issue with --team first"); send
  them as separate updates.
- Ready state is **Todo** (`issue create` lands in Backlog unless `--state Todo`). A
  **ready** issue for the runner is Todo + `auto-execute` + no open blocker. States:
  Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate.
- Session-start listings:
  `linear issue query --project exercise --state "In Progress" --no-input`, the same with
  `--state "In Review"`, and `--state Todo` for the queue. When filtering `--json` output
  by state, use `.state.type` (not in `completed`/`canceled`); `.state.name` is not
  returned by `issue query`.
- Blocks relations: `linear issue relation add AI-603 blocks AI-591 --no-input`. The
  runner holds a labelled issue while a blocks relation points at an open issue; delete
  the relation when you close a blocker. Marking an issue Duplicate needs the relation
  first: `relation add AI-600 duplicate AI-592`, then `--state Duplicate`.
- **Gates** are Todo issues without `auto-execute` (AI-590, AI-593, AI-594). Only the lead
  closes them, after every PR in the wave is MERGED and main's `test` job is green.
- **Owner-run issues** (assigned to Myles, no `auto-execute`): never dispatch or brief an
  agent on them (AI-595, AI-596, AI-597, AI-598, AI-602).
- Issues in the Linear project **worktree-tools** are Myles's: file runner and monitor
  requests there with acceptance checks; never dispatch them.

## Automation and merge path

- **Dispatch label `auto-execute`** on a Todo issue: the worktree-tools dispatch runner
  claims it, moves it to In Progress and opens a PR titled `AI-nnn: ...` from branch
  `AI-nnn`. The lead never writes code or fixes a PR by hand; one issue = one agent =
  one PR.
- **Merge label `auto-merge`**: the PR monitor merges once CI is green and moves the
  issue to Done. Set it at issue creation when the issue's file list stays clear of the
  production path (`api/**`, `src/data/supabase.ts`, `supabase/**`, `vercel.json`). A
  production-path issue gets `auto-execute` only; **since 2026-11-11 evening the lead, not
  Myles, reviews and merges those** ("i don't want to review things", "i want you to make
  good decisions"): `/code-review` at medium (high for migrations and auth paths), findings
  fixed by a subagent on the PR branch, then the lead adds `auto-merge` to the issue and
  tells Myles what shipped (#94, #95, #101, #102, #106). A migration that alters or deletes
  existing production rows gets a high-depth review and a reversibility check, not a
  question. Before that evening Myles reviewed and merged production-path PRs on a
  lead-written brief (#56, #64, #84, #92).
- The monitor **does** merge a lead-opened PR (no runner worktree) when its issue carries
  `auto-merge`: #66 (AI-620) merged four minutes after it was opened, 2026-11-07. The
  monitor merges as soon as CI is green, with no lead read; for non-production paths the
  lead's read is the post-merge verification subagent. The monitor moves the issue to
  Done about ten minutes after the merge (AI-622 on 2026-11-10: merged, In Progress at
  01:04, Done at 01:09; on 2026-11-11 ~3 min for runner PRs #108/#109, merged 21:57Z, Done
  ~22:00Z, and ~15 min for the lead's docs PR #107); wait fifteen minutes before setting Done by hand, and set it by
  hand only for a PR Myles merged himself (#69).
- **Monitor after a failed run.** #100 (AI-640) failed CI, was fixed, went green and CLEAN at
  ~20:14Z, and the monitor merged it only at ~20:55Z; every PR green on its first run merged
  within minutes. Expect a delay of up to 45 min on a PR that was red first.
- **Monitor and lead-opened PRs.** On 2026-11-11 the monitor merged runner PRs but skipped every
  lead-opened PR for 11 h (#79, #82, #83, #87) until Myles fixed it at ~15:00Z; after the fix all
  three merged within seconds and their issues moved to Done ~10 min later. AI-636 (worktree-tools)
  asks for the rule to be documented; until then name a lead PR's branch after the labelled issue
  (`AI-634-docs`), which is harmless and may be required.
- **Dispatcher restarts orphan claims.** A dispatcher restart posts "Agent failed: Orphaned claim"
  and returns the issue to Todo with labels intact; the runner re-claims it when it is next idle.
  No lead action unless a strike removes the label (2026-11-11, AI-640 twice, AI-645).
- **Lead PRs may race.** #81 (based on #79's branch) merged into that branch 27 s after Myles merged
  #79 to main, stranding two commits (PR #82 carried them). Base every PR on main.
- `needs-input` label: blocked on a decision from Myles; leave the issue in Todo or
  Backlog with the questions in a comment.
- Runner quirks seen here: an agent may skip a decided item in the AC (PR #55 left out
  the data-proxy mount and used server-managed `deleted_at`); cut a realignment issue
  (AI-603) rather than reopen. An agent that changes a file outside its Owns list may
  remove `auto-merge` itself (PR #61); verify, then re-add or cut a reversal issue.
- **CI workflow is `ci.yml`** (name `CI`) with two jobs: `test` (`npm run typecheck`,
  `npm test`) on every push and PR, and `migrate` on pushes to main only. Pre-merge and
  gate checks are judged on `test`. `migrate` failed from 2026-10-25 to 2026-11-11 on an
  expired `SUPABASE_ACCESS_TOKEN`; #78 (AI-602, merged 2026-11-11) pinned Supabase CLI 3.1.0
  and pushes with `--remote`; #87 added `--yes` (CLI 3.1.0 prompts otherwise), and both jobs
  are green on main since 2026-11-11. `ci.yml` has **no `workflow_dispatch`**. On 2026-11-11
  20:22Z to 21:1xZ six runs sat "queued" with no jobs for 50 min and could be neither
  cancelled ("completed") nor re-run ("already running"); newer pushes ran normally. The fix
  was a fresh commit on each branch (`git commit-tree` with the same tree, pushed to the
  branch); main was covered by the next merge's run.
- `gh pr checks` and the branch-protection API return 403 with the lead's token. Use
  `gh run list --branch <branch> --limit 1 --json headSha,status,conclusion` and
  `gh run view <id> --json jobs --jq '.jobs[]|"\(.name) \(.conclusion)"'`. Repo setting
  `allow_update_branch` is false: parallel issues must share neither files nor a runtime
  contract, or the second PR goes `BEHIND`.
- Never `gh pr merge` in any form.

## WIP cap and streams

Work runs in **waves** under an epic (AI-386 was the first). Each issue carries an
**Owns** list of files or directories in its acceptance criteria, and a wave's issues
have disjoint Owns lists; dependent issues carry a blocks relation and wait. Observed
sizes: wave 1 ran three issues in parallel (`src/analysis/`, `starkeep/` + manifest,
`api/mcp.ts` + `src/mcp/`); waves 2 and 3 ran as chains of one or two. A gate issue
closes each wave. Investigations with no PR use no slot. Verification of every merged
PR against its ACs goes to a subagent after the merge, and its findings are written
into the pending issues' ACs before they dispatch.

## Validation commands for briefs

- `npm run typecheck` (tsc for the app, `tsconfig.api.json`, `tsconfig.starkeep.json` and
  `tsconfig.scripts.json` for the tsx-run `scripts/**/*.ts`; all four must pass).
- Touched tests: `npx vitest run <files>`; the full suite (`npm test`, ~50 files / 555
  tests as of 2026-11-07) is CI's job.
- `npm run build` when the Vite app changes; `npm run bundle` and `npm run
  starkeep:validate` when `starkeep/` or `starkeep.manifest.json` changes.
- Parity rule for MCP work: `src/mcp/__fixtures__/tools-list.main.json` pins the 32-tool
  list (25 strength + 7 ride tools since AI-654, 2026-11-11); the Starkeep handlers have
  byte-identical parity tests against the Supabase ones.
- Durable facts go in `docs/agents/project-memory.md` (CLAUDE.md rule), one section per
  fact; no ad hoc memory files.

## Environment limits

- The agent container has no `SUPABASE_ACCESS_TOKEN`, no Supabase project access and no
  AWS or Starkeep cloud credentials: nothing can hit production or a Starkeep cloud. Its
  egress reaches GitHub and registry.npmjs.org only: no Garmin or Peloton host (2026-11-11),
  so API probes are owner-run (`scripts/probes/`).
  Live checks (local Starkeep install, cloud deploy, claude.ai connector) are Myles's
  issues, not agent work.
- `git worktree remove` is disabled in containers; list scratch worktrees for the host.
- The lead's GitHub token cannot read or set repository secrets (403); Myles adds them in
  the browser. `/repo/node_modules` is stale against the lockfile (no `@starkeep/*`);
  verifiers run `npm ci` in their worktree rather than symlinking it.
  Known stale ones: `wt-main`, `wt-55` to `wt-61`, `wt-lead`, `wt-lead2`, `wt-verify`
  (earlier sessions), `wt-starkeep`, `wt-verify2`, `wt-lead3` (2026-11-10), `wt-lead4`, `wt-lead5`, `wt-lead6`, `wt-ci635`, `wt-verify85`, `wt-verify86`, `wt-verify88`, `wt-verify89`, `wt-verify90`, `wt-verify91`, `wt-fix84`, `wt-fix92`, `wt-merge92`, `wt-verify92`, `wt-env92`, `wt-verify94`,
  `wt-verify96`, `wt-verify98`, `wt-fix94`, `wt-fix95`, `wt-fix100`, `wt-c6`, `wt-briefs`,
  `wt-fix102`, `wt-verify100`, `wt-verify103`, `wt-verify104`, `wt-verify105`, `wt-fix106`,
  `wt-verify106`, `wt-rebase105` and `wt-lead7` (2026-11-11), `wt-stills`, `wt-stills112`,
  `wt-verify108`, `wt-verify110`, `wt-verify112`, `wt-verify114`, `wt-fix114`, `wt-fix115`,
  `wt-docs675` (2026-11-11 late).
- The container user (uid 1000) cannot `apt-get`; the agent image has Chromium's system
  libraries since AI-666 (2026-11-11 evening). Playwright's headless-shell download
  (cdn.playwright.dev) is blocked, so run `npx playwright install chromium` (works, via the
  npm registry mirror) and symlink
  `~/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell`
  to the installed `chromium-1254` binary; then `npm run screenshots -- --rides --out-dir <dir>`
  renders the ten ride screens from fixtures (`VITE_MOCK_RIDES=1`). Runner containers lack
  the symlink, so agents cannot re-render; the lead renders on the branch.
- Scratch work goes under the session scratchpad directory, never the checkout.
  Starkeep source for research is cloned there (`starkeep-core`, `starkeep-apps`).

## Migrations and production

- **Myles's own daily use of the app runs on Vercel + Supabase and must keep working
  unmodified** (Myles, 2026-11-06). PRs touching `api/**`, `src/data/supabase.ts`,
  `supabase/migrations/**` or `vercel.json` are reviewed by the lead at the depth in
  "Automation and merge path" and merged through `auto-merge` (rule since 2026-11-11
  evening). The Starkeep path (`starkeep/`, `src/data/starkeep*`, manifest) is the lead's.
- Schema changes are files in `supabase/migrations/`; `docs/supabase-migrations.md` says
  how they reach production (the `migrate` CI job on main, green since 2026-11-11; it
  applied `20261111131256_ride_analytics.sql` and `20261111195714_sessions_service_role_select.sql`,
  and `20261111221500_sync_lock.sql` on 2026-11-11 22:37Z). The recovery SQL for a stuck sync
  lease is in `docs/agents/project-memory.md` ("Sync lock").
  The strength tables from `0001_init.sql` grant nothing to `service_role`; a service-role
  read of one needs an explicit grant migration (AI-664).
  Two migrations sharing a version number apply silently as one; CI checks for this
  (`scripts/check-migration-versions.mjs`).
- A second user has data in the Supabase tables (since 2026-11). The
  `workout-analysis` skill's `query.sh` connects as superuser and bypasses RLS: do not use
  it for data questions; use the app's per-user MCP tools.
- Starkeep has no data migration from Supabase; each Starkeep user starts empty.

## Boundary examples for this project

- Myles approves: Supabase auth configuration; rotating repo secrets (AI-602); contacting
  the Starkeep maintainer (AI-598); publishing the source (the `starkeep-apps` PR makes the
  whole repo public); strategy and target numbers. Production-path code and migrations are
  the lead's to review and merge since 2026-11-11 evening (see "Automation and merge path").
- Grey area (decide, flag): Starkeep-only UX (MCP token screen copy, sign-in flow); the
  shape of a Starkeep table that nobody has data in yet.
- Standing rules: epic decisions are listed under "Decisions (do not revisit)" in the
  epic description; a new fact that contradicts one is a question for Myles, not a
  silent re-plan.

## Start-of-session readings

- The current epic's description (AI-627 ride analytics; AI-386 Starkeep is parked on
  owner-run issues): its Decisions and Status sections are the running log. Then `gh pr list --json number,title,state,mergeable`
  and the two Linear state listings above. No metrics scripts.

## Review depth examples

- Read and run: docs, `starkeep/README.md`, manifest-only changes, test-only diffs.
  Auto-merge lands a green PR within minutes, so the lead reads the diff while CI runs:
  #71 (typecheck and the two Starkeep test files run in a scratch worktree), #72 (every
  factual claim in the README checked against the branch with one batched grep), #73.
- Independent verification subagent against the ACs (this repo's equivalent of
  `/code-review medium`): every runner PR after merge (#57 to #63), and before merge
  when it touches the production path (#64: typecheck on all three configs, full vitest,
  byte-level diff of the moved helper, brief posted on the PR).
- Owner review (before 2026-11-11 evening): #56 (AI-589) and #64 (AI-610); Myles asked
  "advise me on pr56" and merged on the lead's brief.
- Lead-reviewed production path (since 2026-11-11 evening): `/code-review <url> medium` on
  #94 (`api/sync.ts` owner path), #102 and #106 (`api/mcp.ts` + handlers); `high` on #95
  (`src/data/supabase.ts` paging). Each review's findings went to one fix subagent on the PR
  branch, then `auto-merge`; a one-line grant migration (#101) was read in full instead.

## Where project things live

| Place | Holds |
|---|---|
| Epic issue description (AI-627; AI-386 parked) | Goal, decisions, established facts, wave plan, status log; rewritten when facts change |
| `docs/agents/project-memory.md` | Durable, non-obvious facts for every agent (CLAUDE.md rule) |
| `starkeep/README.md` | Starkeep server layout, table mapping, local run, bundle contract, env vars |
| `docs/supabase-migrations.md` | How migrations reach production |
| `src/mcp/__fixtures__/tools-list.main.json` | Pinned 32-tool MCP list both backends must match |
| `.claude/skills/workout-analysis/` | Myles's superuser SQL tool; unsafe now that a second user exists |
| Linear project exercise | Tasks, priorities, hand-off comments |
| Linear project worktree-tools | Runner and monitor requests (Myles's) |
| Session scratchpad | Issue description sources, Starkeep clones, scratch worktrees; dies with the container |
