# Lead handoff

Overwritten at the end of each lead session; history is in git.

Written 2026-11-07 21:45 UTC by Claude Fable 5.1 (session 2026-11-06 to 2026-11-07, the Starkeep
epic). Read `/repo/CLAUDE.md` first and invoke the `lead` skill; it reads
`docs/agents/lead-project.md`. Decisions are rows in `docs/agents/decision-log.md`.

## 1. State

**Epic AI-386 (exercise runs as a Starkeep app, per-user, MCP first): all dispatched
engineering is merged.** Waves 1 to 3 closed (gates AI-590, AI-593, AI-594 Done). Main is
green on the `test` job at d4da1e9; the `migrate` job is red on the expired
`SUPABASE_ACCESS_TOKEN` (AI-602, Myles). The epic description holds the decisions, facts
and status log; read it before touching anything Starkeep-related.

### Open PRs
- The lead's docs PR for this handoff and the `lead` skill (AI-620). `auto-merge` is on the
  issue; if the monitor does not merge a lead-opened PR here, Myles merges.

### Owner-run queue (Myles, in order; no agent work)
1. **AI-595** local Starkeep install and MCP smoke test from Claude Code (four tools:
   `list_exercises`, `create_exercise`, `get_day_templates`, `weekly_volume`). Anything
   broken becomes an `auto-execute` issue under AI-386.
2. **AI-596** own Starkeep cloud deploy, cloud install, claude.ai custom connector with a
   bearer token; confirm a second user sees none of his data. Cost estimate given
   2026-11-07: under a dollar a month at his scale (all serverless, free tiers).
3. **AI-597** PR adding the app to `starkeep-org/starkeep-apps`. Decide first whether to
   strip `api/`, `supabase/`, `vercel.json` from the copied folder (the repo is private;
   that PR publishes the folder) and make it pass that repo's `pnpm test`,
   `pnpm typecheck`, `check:links`.
4. **AI-598** asks to the Starkeep maintainer: longer refresh-token validity for the
   `cloud-apps` Cognito client (30 days now, so MCP tokens die monthly), an exported
   revoke helper, and a heads-up that this is the first MCP app. Issue cites files and
   lines.
5. **AI-602** rotate the `SUPABASE_ACCESS_TOKEN` repo secret.

### Backlog under the epic
- AI-611: local `/api/*` gate should refuse cross-site no-Origin GETs via
  `Sec-Fetch-Site`. Not blocking.
- AI-599 (outside the epic): switch the Supabase MCP reads to `src/analysis/`.

### Myles is weighing
Consolidating his projects onto Starkeep. Lead's advice on 2026-11-07: run exercise on his
own Starkeep cloud alongside production for a few weeks first; the open costs are 0.x
churn, the narrow data API, Cognito-only auth and no Supabase-to-Starkeep import yet. If
he decides to go further, a data import issue for exercise is the next thing to write.

## 2. Questions for Myles
None open. The next moves are his (AI-595 onward).

## 3. For the host
Scratch worktrees to remove: `wt-main`, `wt-55` to `wt-61`, `wt-lead` (all under the
session scratchpad). Starkeep clones under the scratchpad can be deleted.
