-- RPC function for exercise-k67.15: security-invoker per-set detail for an exercise,
-- ungrouped (unlike progression_for_exercise's per-day aggregation), exposed the same
-- way so a caller's own bearer token scopes results to their own rows via RLS.

create or replace function public.sets_for_exercise(exercise_name text)
returns table (
  performed_on date,
  set_number int,
  weight numeric,
  reps int
)
language sql
stable
security invoker
set search_path = public
as $$
  select s.performed_on,
         ss.set_number,
         ss.weight,
         ss.reps
  from session_sets ss
  join sessions  s on s.id = ss.session_id
  join exercises e on e.id = ss.exercise_id
  where e.name ilike '%' || exercise_name || '%'
  order by s.performed_on, ss.set_number;
$$;

grant execute on function public.sets_for_exercise(text) to authenticated;
revoke execute on function public.sets_for_exercise(text) from public;

notify pgrst, 'reload schema';
