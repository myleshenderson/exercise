# Lead handoff

Overwritten at the end of each lead session; history is in git.

Written 2026-11-08 03:40 UTC by Claude Fable 5.1 (session 2026-11-07 23:30 to 2026-11-08, the
open-source epic AI-612). Read `/repo/CLAUDE.md` first and invoke the `lead` skill; it reads
`docs/agents/lead-project.md`. Decisions are rows in `docs/agents/decision-log.md`.

## 1. State

**Epic AI-386 (Starkeep): engineering complete.** #65 (AI-607) merged at b6d1217 on Myles's
instruction; post-merge verification passed every AC. The owner-run queue (AI-595 to AI-598,
AI-602) is unchanged from the previous handoff.

**Epic AI-612 (exercise is open source): wave 1 is two-thirds merged.** The epic description's
Status section is the running log; read it first.

- **Merged:** #67 (AI-613, MIT license + identifier scrub) and #68 (AI-614, Supabase DataLayer
  contract tests), both auto-merged by the monitor. Independent verification at 59e0f9e passed
  every AC on both: typecheck green, 51 files / 642 tests, `src/data/supabase.ts` at 100% lines
  and functions, both greps for the project ref and the owner email empty outside
  `supabase/.temp/project-ref`.
- **Waiting on Myles's merge:** #69 (AI-615, CI coverage floor, project ref from the
  `SUPABASE_PROJECT_REF` secret, quiet fixture). Draft, CLEAN, CI green on head 37d40cd with the
  floor enforced. Lead brief posted on the PR. The secret was added by Myles at 00:04 UTC.
- **Ready to dispatch after #69 merges:** AI-617 (serve.ts smoke test). Its only remaining
  blocker is AI-615 (it needs `test:coverage`); the stale AI-607/613/614 relations were removed.
  Before labelling, pin in its description: a CLI guard so importing `serve.ts` does not start
  the server (compare `import.meta.url` with `process.argv[1]`), thread `distDir` through an
  exported `startServer({ distDir, port })`, use a real `buildStarkeepSpa` build into a tmp dir
  (the main-chunk assertion needs it), and do not exercise token issuance (AI-595 covers live).
- **Then AI-616 (docs)**, blocked by 613/614/615. Before labelling: drop the stale AI-607
  blocker sentence from its description; there is no `Schedule.tsx` screen; the README's
  Development section may name `test:coverage` once #69 is in; say `docs/superpowers/` is
  history and can describe superseded states (the July plan still says the ref is hardcoded in
  `query.sh`). Make AC1 and AC3 concrete: the README names the three deployment shapes, that
  `VITE_DATA_BACKEND` unset means the mock backend and no account, the 25-tool MCP server, a
  repo layout table, and links to `LICENSE`, `docs/deploying.md`, `starkeep/README.md`.
- **Owner-run last:** AI-618 (screenshots, gitleaks, flip to public, link from AI-597 and
  starkeep-apps #62).

### Open PRs
- #69 (AI-615): Myles merges. After the merge, watch the first `migrate` run on main: the new
  `Require SUPABASE_PROJECT_REF` step must pass; a failure after it is the known AI-602 token.
- The lead's docs PR for this handoff (issue below). `auto-merge` on the issue; #66 showed the
  monitor does merge lead-opened PRs.

### Facts learned this session
- The monitor merges a labelled PR as soon as CI is green, without a lead read. For
  non-production paths that is the designed flow; the lead's read happens post-merge via the
  verification subagent, and findings go into pending issues' ACs.
- The lead container's GitHub token cannot read or set repo secrets (403); Myles sets them in
  the browser.
- `/repo/node_modules` is stale against the lockfile (no `@starkeep/*`): verifiers must
  `npm ci` in their worktree instead of symlinking it.
- Myles's own `.env.local` needs `SUPABASE_DB_HOST=db.<ref>.supabase.co` for the
  `workout-analysis` skill since #67.

## 2. Questions for Myles
None open. Merging #69 is the next move and is his.

## 3. For the host
Scratch worktrees to remove (all under the session scratchpad; `git worktree remove` is
disabled in containers): `wt-verify` (has its own `node_modules`), `wt-lead2`, plus the
previous session's `wt-main`, `wt-55` to `wt-61`, `wt-lead`, and the pr65 verification
worktree under the other session's scratchpad. `git worktree prune` clears the rest.
