# Lead handoff

Overwritten at the end of each lead session; history is in git.

Written 2026-11-11 (session 03:40 UTC onwards) by Claude Fable 5.1. Read `/repo/CLAUDE.md`
first and invoke the `lead` skill; it reads `docs/agents/lead-project.md`. Decisions are rows
in `docs/agents/decision-log.md`.

Myles's direction this session: he is cancelling Strava and wants the app to become his
holistic training view: Garmin for outdoor riding and body weight, Peloton for indoor riding,
the app's own sessions for strength. He asked for planning and mockups first ("i don't want
you to create all of the tickets now"), then scoping together. Nothing has been dispatched.

## 1. State

**Main** is 682b500 (merge of #78), both CI jobs green: `migrate` passes since AI-602 rotated
the token. No open PRs other than this session's docs PR (AI-628, `auto-merge`). Nothing In Progress or In Review.
The repo is **public**; epic **AI-612 (open source) closed** this session (every child Done).

**Epic AI-627 (Garmin Personal API and Peloton replace Strava)** is in Backlog with
`needs-input` and has **no children yet**. Its description holds the first-hand API facts
(from Garmin's official client source, two community clients and the Peloton spec; no host
was reachable from the container), the repo facts, and the decisions so far.

Decided by Myles (2026-11-11): body weight + cycling (Garmin outdoor, Peloton indoor) alongside
strength; Myles-only credentials in Vercel env; Supabase first, Starkeep parity later; backfill
everything; Strava-like My Stats, per-activity view, weekly TSS with fitness/freshness.

**Planning deliverable**: the artifact page "Exercise Ride Analytics Plan" (https://claude.ai/artifact/PwEDmeQjPUHJiLFu2P7AG8, also linked on AI-627) and its Markdown twin
`docs/plans/2026-11-11-ride-analytics-plan.md` (this PR). It carries the Strava analytics
inventory with keep/later/drop, source cards, metric definitions, the proposed storage and
sync pipeline, eight phone-width mockups, MCP tools, four waves with sizes, and a decisions
checklist for Myles.

**Probes**: branch `AI-627-probes` (this PR's branch) holds `scripts/probes/garmin-probe.sh`
and `scripts/probes/peloton-probe.sh` with a README. Myles runs them on his machine and
attaches the outputs to AI-627; Garmin weight units and Peloton login behaviour are unknown
until then.

Owner-run Starkeep issues unchanged: AI-595, AI-596, AI-597, AI-598 (Todo).

### Facts learned this session
- Agent containers reach GitHub (and registry.npmjs.org) but no Garmin or Peloton host.
- Garmin Personal API (launched ~2026-10-21): key from Garmin Connect settings, `POST
  /personalapitoken-service/personal-api/personal-api-key/token` with `Authorization: ApiKey`,
  bare JWT back (24 h), pull-only, no webhooks/backfill/Training API; strength sets only in FIT.
- The unofficial `garminconnect` library (used by `scripts/garmin_export.py`) has failed
  since March 2026; the Personal API weight endpoint replaces that script.
- `linear issue create` accepts `--team AI` in this container; `issue update` can change title
  and description together.

## 2. Questions for Myles
1. Read the planning page; the "Decisions for Myles" section lists what scoping needs
   (first-cut screens, TSB convention, strength TSS default, best-efforts list, Strava archive
   import yes/no, eFTP method, Home strip, Peloton rides in distance bests).
2. Owner actions: request the Strava data archive before the term ends; run the two probes
   and attach outputs to AI-627; rotate the Garmin key pasted in chat; record FTP and
   threshold HR.
3. Starkeep owner-run queue (AI-595, AI-596) is still yours when you want it.

## 3. For the host
Scratch worktrees to remove (under the session scratchpad; `git worktree remove` is disabled in
containers): `wt-lead4` (this PR), plus earlier sessions' `wt-main`, `wt-55` to `wt-61`,
`wt-lead`, `wt-lead2`, `wt-lead3`, `wt-verify`, `wt-verify2`, `wt-starkeep`.
