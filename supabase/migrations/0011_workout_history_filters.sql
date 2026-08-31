-- Add optional date-range and exercise-name filters to get_workout_history
-- (exercise-k67.16). Postgres doesn't let create-or-replace change a function's
-- parameter list in place, so the old zero-arg signature is dropped first -
-- otherwise the two would coexist as an ambiguous overload for a zero-arg call.
drop function if exists public.get_workout_history();

create or replace function public.get_workout_history(
  start_date date default null,
  end_date date default null,
  exercise_name text default null
)
returns table (
  session_id uuid,
  performed_on date,
  workout_day_id uuid,
  workout_day_name text,
  exercise_id uuid,
  exercise_name text,
  set_number int,
  weight numeric,
  reps int
)
language sql
stable
security invoker
set search_path = public
as $$
  select s.id                as session_id,
         s.performed_on      as performed_on,
         wd.id                as workout_day_id,
         wd.name              as workout_day_name,
         e.id                 as exercise_id,
         e.name               as exercise_name,
         ss.set_number        as set_number,
         ss.weight            as weight,
         ss.reps              as reps
  from sessions s
  left join workout_days wd on wd.id = s.workout_day_id
  left join session_sets ss on ss.session_id = s.id
  left join exercises e on e.id = ss.exercise_id
  where (start_date is null or s.performed_on >= start_date)
    and (end_date is null or s.performed_on <= end_date)
    and (
      exercise_name is null
      -- Escape the caller's literal text before wrapping it in our own % wildcards,
      -- so a name containing % or _ (Postgres's default LIKE escape is backslash)
      -- is matched as a literal substring instead of those chars acting as wildcards.
      or e.name ilike '%' || replace(replace(replace(exercise_name, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
  order by s.performed_on, s.id, ss.set_number;
$$;

grant execute on function public.get_workout_history(date, date, text) to authenticated;
revoke execute on function public.get_workout_history(date, date, text) from public;

notify pgrst, 'reload schema';
