# Lead handoff

Overwritten at the end of each lead session; history is in git.

Written 2026-11-10 (session 00:40 UTC onwards) by Claude Fable 5.1. Read `/repo/CLAUDE.md`
first and invoke the `lead` skill; it reads `docs/agents/lead-project.md`. Decisions are rows
in `docs/agents/decision-log.md`.

Myles's two stated goals this session: "publishing this open source and getting this
published to my personal star keep". Both now wait only on owner-run steps.

## 1. State

**Main** is 56f3a78 (merge of #73), `test` green. `migrate` fails only at `Apply pending
migrations` (expired token, AI-602); the `Require SUPABASE_PROJECT_REF` step added by #69
passes.

**Epic AI-612 (exercise is open source): engineering complete.** Merged this session, in order:

- #69 (AI-615, CI coverage floor + project ref from a secret), merged by Myles at 00:47 UTC.
- #71 (AI-617, `starkeep/serve.ts` smoke test: exported `startServer({ distDir, port })`,
  CLI guard, `portFromArgv` exported, 13 new tests) and #72 (AI-616, public README,
  `docs/deploying.md`, `docs/supabase-migrations.md` reduced to a pointer, three fixes in
  `starkeep/README.md`), both auto-merged ~15 minutes after dispatch.
- #73 (AI-622, the stale-text leftovers #72's agent listed plus the lockfile `license`
  field), auto-merged.
- Independent verification at 686ccdc passed every AC of AI-617 and AI-616: 22/22 tests
  in the two Starkeep files, `serve.ts` at 91.5% lines, `npm run starkeep:serve -- -p 5199`
  rebuilt `dist/` and answered 200 on `/` and 403 on a foreign Host, all 17 relative links
  resolve, the `migrate` description matches `ci.yml`. Its two wording gaps in
  `docs/deploying.md` are fixed in this handoff's PR.

**What remains for the public flip is AI-618, owner-run.** Its description is now an
eight-step checklist with one command and one check per step: the secret step is already
done (confirmed by the passing `Require SUPABASE_PROJECT_REF` step), then screenshots to
`docs/images/home.png` and `docs/images/mcp.png` replacing the two README placeholders, a
gitleaks full-history scan, `gh repo edit --visibility public`, post-flip checks, and link
comments on AI-597 and starkeep-apps #62. The lead closes epic AI-612 after AI-618 is Done.

**Epic AI-386 (Starkeep): engineering complete; owner-run queue.** A readiness check this
session built the bundle from main (`npm run bundle`, `starkeep:validate`, typecheck all
pass; the main chunk is a Starkeep-mode build) and found nothing in the repo that blocks
Myles. Owner-run issues:

- AI-595 (local install + MCP smoke test): Myles ran it on 2026-11-07; only the
  post-AI-607 "Generate token" recheck is open. Comment on the issue says what to check,
  then set Done. The blocks relation on AI-596 is released when it closes.
- AI-596 (own Starkeep cloud, cloud-install, connect claude.ai): description rewritten with
  exact steps A to F (manual `npm ci && pnpm bundle` because the installer calls pnpm and
  this repo is npm; `zip` on PATH; Cognito user in `starkeep-users`; app URL
  `https://<cloud>/apps/exercise/`; connector fallback via the MCP screen's
  `claude mcp add` line; second-user isolation procedure; sign out and back in before
  minting). Three values are left for Myles to record: the starkeep-core README Part B
  link, the three stack output names, the admin-web button labels.
- AI-597 (starkeep-apps PR), AI-598 (maintainer question), AI-602 (rotate the token).

**Backlog housekeeping:** AI-384 moved from In Progress (since 2026-10-25, no PR) back to
Todo.

### Open PRs
- The lead's docs PR for this handoff (AI-623, `auto-merge` on the issue; the monitor merges
  lead-opened PRs).

### Facts learned this session
- The monitor moves an auto-merged PR's issue to Done about ten minutes after the merge;
  setting Done by hand before that is premature (done twice this session before the lag was
  measured).
- `linear issue update` refuses `--state` together with `--add-label`; separate calls.
- The runner opened both PRs within ~5 minutes of labelling and CI took ~6 minutes; the
  lead's read-and-run fits inside that window if started at the "PR opened" event.
- `supabase/.temp/project-ref` was tracked in history from 96ed120 until 37d40cd (#69), so
  the public history will contain the production project ref (not a credential; see Q3).

## 2. Questions for Myles
1. **AI-595:** restart Exercise once, confirm the MCP screen shows `/mcp` and "Generate
   token" mints, set the issue Done.
2. **AI-596:** run the checklist; record the three missing values as you go.
3. **Project ref in git history** (AI-618): the lead's default is no history rewrite before
   the flip, since a Supabase project ref is in every client URL and is not a secret. Say
   so if you want it scrubbed; that adds a history-rewrite step before going public.
4. **Grey area, flagged not changed:** the bottom nav labels the ManageDays screen
   "Schedule" while the README calls it ManageDays. A rename either way is a copy decision.

## 3. For the host
Scratch worktrees to remove (under the session scratchpad; `git worktree remove` is
disabled in containers): `wt-starkeep` (clean), `wt-verify2` (`node_modules` deleted by the
verifier), `wt-lead3` (this PR), plus earlier sessions' `wt-main`, `wt-55` to `wt-61`,
`wt-lead`, `wt-lead2`, `wt-verify`. `git worktree prune` clears the rest.
