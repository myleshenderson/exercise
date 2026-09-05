-- Append-only audit log of every progressive scheme written for a (day, exercise)
-- pair via DataLayer.setDayExerciseTarget, so a caller can reconstruct which
-- scheme was in effect at or before any given date (take the latest row with
-- recorded_at <= that date). No update/delete policy is created for this table
-- and only select/insert are granted below — the write path never updates or
-- deletes a history row, only ever inserts a new one.
create table workout_day_exercise_scheme_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  workout_day_id uuid not null references workout_days(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  target_sets jsonb,
  recorded_at timestamptz not null default now()
);

alter table workout_day_exercise_scheme_history enable row level security;

-- This table postdates 0002's blanket grant (which only covered tables that
-- existed at the time it ran — see 0009's comment for the same gotcha), so it
-- needs its own explicit grant. select+insert only, matching the policies below.
grant select, insert on workout_day_exercise_scheme_history to authenticated;

create policy "own_select" on workout_day_exercise_scheme_history for select
  using (user_id = auth.uid());

create policy "own_insert" on workout_day_exercise_scheme_history for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from workout_days wd where wd.id = workout_day_id and wd.user_id = auth.uid())
    and exists (select 1 from exercises e where e.id = exercise_id and e.user_id = auth.uid())
  );

-- RPC for exercise-k67.20: security-invoker point-in-time lookup, exposed the same
-- way as the other analysis RPCs so a caller's own bearer token scopes results to
-- their own rows via RLS. Parameters are referenced positionally ($1/$2) below
-- since their names intentionally match the table's column names.
create or replace function public.scheme_history_for_day_exercise(workout_day_id uuid, exercise_id uuid)
returns table (
  target_sets jsonb,
  recorded_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select h.target_sets, h.recorded_at
  from workout_day_exercise_scheme_history h
  where h.workout_day_id = $1
    and h.exercise_id = $2
  order by h.recorded_at;
$$;

grant execute on function public.scheme_history_for_day_exercise(uuid, uuid) to authenticated;
revoke execute on function public.scheme_history_for_day_exercise(uuid, uuid) from public;

notify pgrst, 'reload schema';
