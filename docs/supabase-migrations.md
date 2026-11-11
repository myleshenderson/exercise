# Supabase migrations: how they reach production

**Policy: migrations auto-apply to production from `main`.** A file merged
into `supabase/migrations/` on `main` is applied by the `migrate` job in
`.github/workflows/ci.yml` on the CI run for that push. Update this note if
that stops being true.

The job runs `supabase db push --remote --yes`. CLI 3.x asks for interactive
confirmation whenever a migration is pending, and a CI step has no terminal, so
without `--yes` it exits 1 and applies nothing (seen 2026-11-11 on the merge of
AI-631, the first pending migration after AI-602 re-pinned the CLI; AI-635).

How the job works, the `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN`
secrets it needs, how to name a new migration, and the history of the
pipeline are in [deploying.md](deploying.md#how-migrations-reach-production).
