-- The ride sync (AI-641) runs as service_role and reads strength sessions for the
-- daily training load (fixed 50 TSS per session). 0001_init granted nothing to
-- service_role on the strength tables, so the recompute failed with 42501 (AI-642).
grant select on public.sessions to service_role;

notify pgrst, 'reload schema';
