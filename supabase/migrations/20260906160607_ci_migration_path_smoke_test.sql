-- Proves the CI `migrate` job (exercise-4ly) actually applies a migration
-- merged to main, with nobody running `supabase db push` by hand.
comment on schema public is 'exercise-4ly: CI migration auto-apply verified 2026-09-06';
