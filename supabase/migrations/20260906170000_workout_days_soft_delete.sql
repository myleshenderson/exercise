-- Soft-delete support for workout_days (exercise-3y9): delete_day_template used
-- to hard-delete the row, which cascaded away workout_day_exercise_scheme_history
-- for that day, leaving scheme_history_for_day_exercise / adherence_for_day unable
-- to resolve prescribed targets for historical session dates. Deleting a day now
-- just marks it deleted_at instead of removing the row, so its children (exercise
-- attachments, scheme history) and any sessions that reference it stay intact.
-- get_day_templates excludes soft-deleted days so they don't reappear in normal
-- listings.

alter table workout_days add column deleted_at timestamptz;

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
  where wd.deleted_at is null
  order by wd.position, wde.position;
$$;

notify pgrst, 'reload schema';
