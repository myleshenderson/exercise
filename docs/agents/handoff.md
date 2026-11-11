# Handoff (2026-11-11, afternoon lead session, 12:00 to 15:50 UTC)

## 1. State

- **main** green (test + migrate) at the #82 merge 57fd7ac and after. The ride-analytics
  migration `20261111131256_ride_analytics.sql` **is applied in production** (migrate job on
  5f1c4c4, 15:04Z) after #87 added `--yes` to `supabase db push --remote` (AI-635).
- **Epic AI-627:** 16 decisions in its description; payload facts (two probe zips, lead
  write-up 13:14Z) as comments. Planning page https://claude.ai/artifact/PwEDmeQjPUHJiLFu2P7AG8.
- **Wave 1 Done:** AI-631 schema (#84, migration applied), AI-632 maths (#85), AI-633 FIT (#86).
  All three verified post-merge, no follow-ups.
- **Wave 2:** AI-637 core (#88), AI-638 Garmin (#89), AI-639 Peloton (#90), AI-646 FTP-history
  collapse (#91) merged and verified, no follow-ups. **AI-641 runner: PR #92 draft, CLEAN, CI
  green on c392ec3, review brief posted 15:3xZ; Myles merges** (production path: `api/sync.ts`,
  `vercel.json`). AI-640 Strava import and AI-645 FIT start offset: Todo + labels, unclaimed
  since the dispatcher restart orphaned them (~15:00Z). AI-648 typecheck scripts: Todo, blocked
  by AI-641 (shared `package.json`). Owner-run AI-642 (env vars, first backfill, size check) and
  AI-643 (Strava import run) wait on #92 and AI-640. Gate AI-644.
- **Wave 3 filed 15:38Z:** AI-649 UI foundation (Todo, `auto-execute` + `auto-merge`, brief read
  by the lead), AI-650 feed + detail, AI-651 My Stats + Training, AI-652 Power + Weight +
  Settings, AI-653 owner-authenticated sync endpoint (production path), AI-654 MCP tools
  (production path), AI-655 paging fix for DataLayer list reads (production path, `auto-execute`,
  draft PR for Myles; My Stats waits on it), gate AI-656. Relations: 649→650/651/652/654,
  641→653, 653→652, 655→651. Briefs for 650–654 are in the lead's scratchpad `wave3/` and must
  be read before their labels are added (the drafter's cover note is in the same folder).
- **Open PRs:** #92 (Myles). This docs PR (AI-657).
- **Dispatcher:** idle since ~15:00Z; AI-649, AI-655, AI-640, AI-645 are labelled Todo and
  unclaimed. Myles's side (AI-630 rate-limit handling, AI-636 monitor rule, AI-647 host restart).

### Facts learned this session (after 13:50Z)

- CLI 3.x `supabase db push --remote` needs `--yes` in CI; the AI-602 run passed only because
  nothing was pending. `docs/supabase-migrations.md` now says so.
- Monitor: after Myles's fix, lead-opened PRs merge and their issues reach Done ~10 min later.
- `src/data/supabase.ts` list reads do not page: PostgREST's 1000-row cap would truncate
  all-time stats once the backfill lands (AI-655).
- `@garmin/fitsdk`'s licence forbids redistribution; the FIT decoder is hand-written.
- Garmin has no HR for Myles's account; rides without power get the flat 55 TSS/h (decision 16).
- Runner-filed follow-ups arrive with either/or wording; the lead re-pins them before labelling
  (AI-645, AI-646, AI-648).

## 2. Questions for Myles

None blocking. Grey-area call to confirm or reverse: Activities and Stats nav links visible to
every account (the second user sees empty states; sync controls are owner-only). Still open from
the morning: request the Strava archive, rotate the Garmin key, set the Vercel env vars listed in
#92's brief, then run AI-642.

## 3. For the host

Remove scratch worktrees under the scratchpad directory: `wt-lead4`, `wt-lead5`, `wt-lead6`,
`wt-ci635`, `wt-verify85`, `wt-verify86`, `wt-verify88`, `wt-verify89`, `wt-verify90`,
`wt-verify91`, `wt-fix84`, `wt-fix92`, `wt-merge92`, plus the earlier ones in the profile.
Branch `AI-627-probes` can be deleted (#82 carried its last commits).
