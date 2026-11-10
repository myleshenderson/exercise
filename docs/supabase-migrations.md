# Supabase migrations: how they reach production

**Policy: migrations auto-apply to production from `main`.** A file merged
into `supabase/migrations/` on `main` is applied by the `migrate` job in
`.github/workflows/ci.yml` on the CI run for that push. Update this note if
that stops being true.

How the job works, the `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN`
secrets it needs, how to name a new migration, and the history of the
pipeline are in [deploying.md](deploying.md#how-migrations-reach-production).
