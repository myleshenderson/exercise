-- mcp_sessions relies on service_role bypassing RLS (see 0004's comment), but
-- bypassing RLS doesn't skip the table-level GRANT check Postgres enforces
-- before RLS is even evaluated. 0002's grants only covered anon/authenticated,
-- and only for tables that existed at the time it ran — mcp_sessions was
-- created later in 0004, so it never got any role's grants. Without this,
-- every insert/select/update from the service-role client fails with 42501
-- "permission denied for table mcp_sessions".
grant select, insert, update on public.mcp_sessions to service_role;

notify pgrst, 'reload schema';
