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
  issue to Done. Set it at issue creation only when the issue's file list stays clear of
  the production path (next section). A PR that touches `api/**`, `src/data/supabase.ts`,
  `supabase/**` or `vercel.json` gets **no `auto-merge`**: Myles reviews and merges (#56
  AI-589, #64 AI-610). The lead posts a plain-language review brief on the PR first.
- The monitor **does** merge a lead-opened PR (no runner worktree) when its issue carries
  `auto-merge`: #66 (AI-620) merged four minutes after it was opened, 2026-11-07. The
  monitor merges as soon as CI is green, with no lead read; for non-production paths the
  lead's read is the post-merge verification subagent. The monitor moves the issue to
  Done about ten minutes after the merge (AI-622 on 2026-11-10: merged, In Progress at
  01:04, Done at 01:09); wait fifteen minutes before setting Done by hand, and set it by
  hand only for a PR Myles merged himself (#69).
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
  and pushes with `--remote`, and both jobs are green on main 682b500.
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
- Parity rule for MCP work: `src/mcp/__fixtures__/tools-list.main.json` pins the 25-tool
  list; the Starkeep handlers have byte-identical parity tests against the Supabase ones.
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
  (earlier sessions), `wt-starkeep`, `wt-verify2`, `wt-lead3` (2026-11-10), `wt-lead4`, `wt-lead5`, `wt-lead6`, `wt-ci635`, `wt-verify85`, `wt-verify86`, `wt-verify88`, `wt-verify89`, `wt-verify90`, `wt-verify91`, `wt-fix84`, `wt-fix92` and `wt-merge92` (2026-11-11)
  (2026-11-11).
- Scratch work goes under the session scratchpad directory, never the checkout.
  Starkeep source for research is cloned there (`starkeep-core`, `starkeep-apps`).

## Migrations and production

- **Myles's own daily use of the app runs on Vercel + Supabase and must keep working
  unmodified** (Myles, 2026-11-06). Any PR touching `api/**`, `src/data/supabase.ts`,
  `supabase/migrations/**` or `vercel.json` is reviewed and merged by Myles, never
  `auto-merge`. The Starkeep path (`starkeep/`, `src/data/starkeep*`, manifest) is the
  lead's to decide.
- Schema changes are files in `supabase/migrations/`; `docs/supabase-migrations.md` says
  how they reach production (the `migrate` CI job on main, currently failing: AI-602).
  Two migrations sharing a version number apply silently as one; CI checks for this
  (`scripts/check-migration-versions.mjs`).
- A second user has data in the Supabase tables (since 2026-11). The
  `workout-analysis` skill's `query.sh` connects as superuser and bypasses RLS: do not use
  it for data questions; use the app's per-user MCP tools.
- Starkeep has no data migration from Supabase; each Starkeep user starts empty.

## Boundary examples for this project

- Myles approves: anything that changes behaviour of the Vercel/Supabase deployment;
  Supabase auth or RLS changes; rotating repo secrets (AI-602); contacting the Starkeep
  maintainer (AI-598); publishing the source (the `starkeep-apps` PR makes the whole repo
  public).
- Grey area (decide, flag): Starkeep-only UX (MCP token screen copy, sign-in flow); the
  shape of a Starkeep table that nobody has data in yet.
- Standing rules: epic decisions are listed under "Decisions (do not revisit)" in the
  epic description; a new fact that contradicts one is a question for Myles, not a
  silent re-plan.

## Start-of-session readings

- The current epic's description (AI-386 while the Starkeep work runs): its Status
  section is the running log. Then `gh pr list --json number,title,state,mergeable`
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
- Owner review: #56 (AI-589, extracting tool definitions out of `api/mcp.ts`) and #64
  (AI-610). Myles asked "advise me on pr56" and merged on the lead's brief.

## Where project things live

| Place | Holds |
|---|---|
| Epic issue description (AI-386) | Goal, decisions, established facts, wave plan, status log; rewritten when facts change |
| `docs/agents/project-memory.md` | Durable, non-obvious facts for every agent (CLAUDE.md rule) |
| `starkeep/README.md` | Starkeep server layout, table mapping, local run, bundle contract, env vars |
| `docs/supabase-migrations.md` | How migrations reach production |
| `src/mcp/__fixtures__/tools-list.main.json` | Pinned 25-tool MCP list both backends must match |
| `.claude/skills/workout-analysis/` | Myles's superuser SQL tool; unsafe now that a second user exists |
| Linear project exercise | Tasks, priorities, hand-off comments |
| Linear project worktree-tools | Runner and monitor requests (Myles's) |
| Session scratchpad | Issue description sources, Starkeep clones, scratch worktrees; dies with the container |
