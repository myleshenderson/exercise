-- Grant table privileges to the PostgREST API roles. RLS (enabled in 0001) still
-- restricts every row to its owner (user_id = auth.uid()); these grants are the
-- table-level access Postgres requires BEFORE RLS is evaluated. Needed because the
-- tables were created via raw SQL migration (the dashboard table editor would
-- otherwise auto-grant these). Without them, the API returns 42501
-- "permission denied for table ...".
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
