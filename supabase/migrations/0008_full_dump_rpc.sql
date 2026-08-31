-- RPC functions for full-fidelity raw dumps (exercise-k67.10): security-invoker
-- functions, same shape as the 0005 analysis RPCs, exposed via PostgREST so a
-- caller's own bearer token resolves auth.uid() and the existing RLS policies on
-- workout_days/workout_day_exercises/exercises/sessions/session_sets scope every
-- result to that caller's own rows. No schema changes; query.sh and the app are
-- unaffected.

create or replace function public.get_day_templates()
returns table (
  workout_day_id uuid,
  workout_day_name text,
  workout_day_position int,
  exercise_id uuid,
  exercise_name text,
  exercise_cue text,
  exercise_position int,
  target_sets jsonb,
  uses_default_scheme boolean,
  default_sets int,
  default_rep_low int,
  default_rep_high int
)
language sql
stable
security invoker
set search_path = public
as $$
  select wd.id                       as workout_day_id,
         wd.name                     as workout_day_name,
         wd.position                 as workout_day_position,
         e.id                        as exercise_id,
         e.name                      as exercise_name,
         e.cue                       as exercise_cue,
         wde.position                as exercise_position,
         wde.target_sets             as target_sets,
         wde.target_sets is null     as uses_default_scheme,
         e.default_sets              as default_sets,
         e.default_rep_low           as default_rep_low,
         e.default_rep_high          as default_rep_high
  from workout_days wd
  left join workout_day_exercises wde on wde.workout_day_id = wd.id
  left join exercises e on e.id = wde.exercise_id
  order by wd.position, wde.position;
$$;

create or replace function public.get_workout_history()
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
  order by s.performed_on, s.id, ss.set_number;
$$;

-- PostgREST exposes public-schema functions at /rest/v1/rpc/<name>; only authenticated
-- callers may invoke them. Postgres grants EXECUTE to PUBLIC by default on function
-- creation (see 0006's fix for the same gap on the analysis RPCs), so the explicit
-- authenticated grant alone would leave anon able to call these too - revoke PUBLIC's
-- default access in the same migration this time.
grant execute on function public.get_day_templates() to authenticated;
grant execute on function public.get_workout_history() to authenticated;
revoke execute on function public.get_day_templates() from public;
revoke execute on function public.get_workout_history() from public;

notify pgrst, 'reload schema';
