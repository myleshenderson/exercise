# Supabase migrations: how they reach production

**Status as of 2026-09-06: migrations DO auto-apply to production.** A file
merged into `supabase/migrations/` on `main` is applied by the `migrate` job
in `.github/workflows/ci.yml` on the next CI run for that push. Update this
note if that stops being true.

## How it works

- CI job `migrate` (needs `test`, runs only on push to `main`) runs
  `supabase link --project-ref "$SUPABASE_PROJECT_REF"` then
  `supabase db push`, authenticated with the `SUPABASE_ACCESS_TOKEN` repo
  secret only.
- No `SUPABASE_DB_PASSWORD` is needed or configured: Supabase CLI 2.x
  provisions a temporary login role from the access token. (Confirmed working
  by `myleshenderson/dice-engine`'s `ci.yml` on CLI 2.113.0, and adopted here.)
- The project ref comes from the `SUPABASE_PROJECT_REF` repo secret (it is
  no longer committed); the job fails at its first step if that secret is
  unset.
- If `SUPABASE_ACCESS_TOKEN` is ever unset, the step logs a loud
  `::warning::` and exits 0 rather than failing `main`.

## What this replaced

Supabase's dashboard GitHub-branch integration (linking Supabase's `main`
branch to this repo's `main` git branch) was configured on project creation
but entered `MIGRATIONS_FAILED` on 2026-06-23T01:29 — one day after the
project was created — and never succeeded again. It was decommissioned
(preview branching disabled on the project) as part of exercise-4ly rather
than debugged further, because:

- The Management API exposes no logs or error detail for a failed branch
  migration run, so the original failure was undiagnosable from the outside.
- `dice-engine`, a sibling project by the same owner, doesn't use this
  integration at all — it relies solely on the CI-based push above, which is
  provably testable end-to-end.

Every migration that reached production before this fix (0001 through the
two applied for exercise-k67.20/exercise-k67.18) got there via manual
intervention — `supabase db push` / manual application, never the dashboard
integration.

## The 0012 collision and version drift

`0012_scheme_history.sql` and `0013_adherence_for_day_rpc.sql` used to sit
under filenames whose numeric prefixes (`0012`, `0013`) didn't match what
production's migration ledger actually recorded for them
(`20260906151951`, `20260906152003`). That's because the `0012` filename
collision with `0012_mcp_sessions_last_used_at.sql` blocked `supabase db
push` outright, so those two migrations had been applied manually via the
Management API instead, which assigned them auto-generated timestamp
versions. They've been renamed to
`20260906151951_scheme_history.sql` and
`20260906152003_adherence_for_day_rpc.sql` to match what production actually
has recorded — renumbering them to any other value would have left `supabase
db push` unable to reconcile local files against the remote ledger.

**Going forward:** always create new migrations with `supabase migration new
<name>` so the filename's timestamp prefix is unique and never needs manual
renumbering.

## The 20260906180000 collision (exercise-8qg)

`20260906180000_day_sequencing.sql` (exercise-w8s) and
`20260906180000_exercises_soft_delete.sql` (exercise-2bv) were merged with the
identical version prefix. The `migrate` job's ledger only records one
migration per version, so only `exercises_soft_delete` was ever applied;
`day_sequencing` silently never ran even though `supabase db push` reported
success. Confirmed directly against production (Management API): no
`programs` table, no `program_id`/`program_position` columns on
`workout_days`, `get_day_templates()` still the pre-w8s 12-column signature.

`day_sequencing` has been renamed to `20260906180100_day_sequencing.sql` — a
version after the one production already has recorded for
`exercises_soft_delete` — so `supabase db push` treats it as a genuinely new,
unapplied migration on the next push to `main`. See exercise-kch for the
follow-up to make the `migrate` job detect a version collision instead of
silently dropping one migration.
