-- RPC function for exercise-k67.18: compares a user's actual logged sets against the
-- prescribed target for the same (day, exercise) pairing and session date, and flags
-- under-/over-shooting on sets, reps, and/or weight. Security-invoker, exposed the
-- same way as the other analysis RPCs, so a caller's own bearer token scopes results
-- to their own rows via RLS.
--
-- The prescribed target for a given session is resolved per session date, not from
-- whatever the scheme currently is: the scheme in effect on that date is the latest
-- workout_day_exercise_scheme_history row at or before the session's date (exercise-
-- k67.20). If no history row exists at or before that date at all (e.g. the scheme
-- was set before k67.20 existed, so no history was ever recorded for it), fall back
-- to the current target_sets value on workout_day_exercises. If that's also null (no
-- scheme was ever defined for the pairing), fall back to the exercise's uniform
-- defaults (default_sets sets of default_rep_low-default_rep_high reps, no
-- prescribed weight).
--
-- for_workout_day_id is named to avoid colliding with the workout_day_id column that
-- sessions/workout_day_exercises/workout_day_exercise_scheme_history all have -
-- start_date/end_date don't share a name with any column so are referenced bare, as
-- in get_workout_history (0011).
create or replace function public.adherence_for_day(
  for_workout_day_id uuid default null,
  start_date date default null,
  end_date date default null
)
returns table (
  session_id uuid,
  performed_on date,
  workout_day_id uuid,
  workout_day_name text,
  exercise_id uuid,
  exercise_name text,
  actual_sets bigint,
  target_sets int,
  sets_status text,
  actual_avg_reps numeric,
  target_rep_low int,
  target_rep_high int,
  reps_status text,
  actual_top_weight numeric,
  target_weight numeric,
  weight_status text
)
language sql
stable
security invoker
set search_path = public
as $$
  with actual as (
    select
      s.id                as session_id,
      s.performed_on      as performed_on,
      s.workout_day_id    as workout_day_id,
      wd.name             as workout_day_name,
      ss.exercise_id      as exercise_id,
      e.name              as exercise_name,
      e.default_sets      as default_sets,
      e.default_rep_low   as default_rep_low,
      e.default_rep_high  as default_rep_high,
      count(*)            as actual_sets,
      avg(ss.reps)        as actual_avg_reps,
      max(ss.weight)      as actual_top_weight
    from sessions s
    join session_sets ss on ss.session_id = s.id
    left join workout_days wd on wd.id = s.workout_day_id
    left join exercises e on e.id = ss.exercise_id
    where (for_workout_day_id is null or s.workout_day_id = for_workout_day_id)
      and (start_date is null or s.performed_on >= start_date)
      and (end_date is null or s.performed_on <= end_date)
    group by s.id, s.performed_on, s.workout_day_id, wd.name, ss.exercise_id, e.name,
             e.default_sets, e.default_rep_low, e.default_rep_high
  ),
  resolved as (
    select
      a.*,
      case when h.history_exists then h.history_target_sets else c.current_target_sets end as target_sets_json
    from actual a
    left join lateral (
      select
        exists (
          select 1
          from workout_day_exercise_scheme_history sh
          where sh.workout_day_id = a.workout_day_id
            and sh.exercise_id = a.exercise_id
            and sh.recorded_at::date <= a.performed_on
        ) as history_exists,
        (
          select sh.target_sets
          from workout_day_exercise_scheme_history sh
          where sh.workout_day_id = a.workout_day_id
            and sh.exercise_id = a.exercise_id
            and sh.recorded_at::date <= a.performed_on
          order by sh.recorded_at desc
          limit 1
        ) as history_target_sets
    ) h on true
    left join lateral (
      select wde.target_sets as current_target_sets
      from workout_day_exercises wde
      where wde.workout_day_id = a.workout_day_id
        and wde.exercise_id = a.exercise_id
      limit 1
    ) c on true
  ),
  targets as (
    select
      r.*,
      coalesce(jsonb_array_length(r.target_sets_json), r.default_sets) as target_sets_count,
      coalesce(te.min_reps, r.default_rep_low)                         as target_rep_low,
      coalesce(te.max_reps, r.default_rep_high)                        as target_rep_high,
      te.max_weight                                                    as target_weight
    from resolved r
    left join lateral (
      select
        min((elem->>'reps')::int)      as min_reps,
        max((elem->>'reps')::int)      as max_reps,
        max((elem->>'weight')::numeric) as max_weight
      from jsonb_array_elements(coalesce(r.target_sets_json, '[]'::jsonb)) elem
    ) te on true
  )
  select
    session_id,
    performed_on,
    workout_day_id,
    workout_day_name,
    exercise_id,
    exercise_name,
    actual_sets,
    target_sets_count as target_sets,
    case
      when actual_sets < target_sets_count then 'under'
      when actual_sets > target_sets_count then 'over'
      else 'match'
    end as sets_status,
    round(actual_avg_reps, 1) as actual_avg_reps,
    target_rep_low,
    target_rep_high,
    case
      when actual_avg_reps < target_rep_low then 'under'
      when actual_avg_reps > target_rep_high then 'over'
      else 'match'
    end as reps_status,
    actual_top_weight,
    target_weight,
    case
      when target_weight is null then null
      when actual_top_weight < target_weight then 'under'
      when actual_top_weight > target_weight then 'over'
      else 'match'
    end as weight_status
  from targets
  order by performed_on, session_id, exercise_name;
$$;

grant execute on function public.adherence_for_day(uuid, date, date) to authenticated;
revoke execute on function public.adherence_for_day(uuid, date, date) from public;

notify pgrst, 'reload schema';
