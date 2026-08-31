-- Postgres grants EXECUTE on a new function to PUBLIC by default, so the
-- 0005 migration's explicit "grant ... to authenticated" left anon (a PUBLIC
-- member) able to call these functions too. RLS still returned it zero rows
-- (auth.uid() is null for anon, and user_id is never null), so no data
-- leaked — but the intent was authenticated-only exposure. Revoke PUBLIC's
-- default access to match.
revoke execute on function public.progression_for_exercise(text) from public;
revoke execute on function public.weekly_volume() from public;
revoke execute on function public.training_gaps() from public;

notify pgrst, 'reload schema';
