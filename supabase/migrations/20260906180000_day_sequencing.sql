-- Day sequencing (exercise-w8s): programs group workout_days into an ordered,
-- one-time progression, not a repeating rotation (see the design doc's "Track
-- lifecycle" decision). program_id/program_position stay null for untracked
-- days, which behave exactly as before. Availability is derived, not stored:
-- get_day_templates computes each day's is_available on every call from actual
-- session history, so there is no separate pointer that can drift.

create table programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table programs enable row level security;

-- This table postdates 0002's blanket grant (which only covered tables that
-- existed at the time it ran — see 20260906151951_scheme_history.sql's comment
-- for the same gotcha), so it needs its own explicit grant.
grant select, insert, update, delete on programs to authenticated;

create policy "own_select" on programs for select using (user_id = auth.uid());
create policy "own_insert" on programs for insert with check (user_id = auth.uid());
create policy "own_update" on programs for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on programs for delete using (user_id = auth.uid());

alter table workout_days
  add column program_id uuid references programs(id) on delete set null,
  add column program_position int;

-- Positions only need to be unique within a program; untracked days (program_id
-- null) must be free to all share program_position null, so this is a partial
-- index rather than a plain unique constraint over both columns.
create unique index workout_days_program_position_uq
  on workout_days (program_id, program_position) where program_id is not null;

create or replace function public.get_day_templates()
returns table (
  workout_day_id uuid,
  workout_day_name text,
  workout_day_position int,
  program_id uuid,
  program_name text,
  program_position int,
  is_available boolean,
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
  with day_done as (
    select distinct s.workout_day_id
    from sessions s
    join session_sets ss on ss.session_id = s.id
    where s.workout_day_id is not null
  ),
  program_next as (
    select wd.program_id, min(wd.program_position) as next_position
    from workout_days wd
    left join day_done dd on dd.workout_day_id = wd.id
    where wd.program_id is not null and wd.deleted_at is null and dd.workout_day_id is null
    group by wd.program_id
  )
  select wd.id                                                 as workout_day_id,
         wd.name                                                as workout_day_name,
         wd.position                                            as workout_day_position,
         p.id                                                   as program_id,
         p.name                                                 as program_name,
         wd.program_position                                    as program_position,
         (p.id is null or wd.program_position = pn.next_position) as is_available,
         e.id                                                   as exercise_id,
         e.name                                                 as exercise_name,
         e.cue                                                  as exercise_cue,
         wde.position                                           as exercise_position,
         wde.target_sets                                        as target_sets,
         wde.target_sets is null                                as uses_default_scheme,
         e.default_sets                                         as default_sets,
         e.default_rep_low                                      as default_rep_low,
         e.default_rep_high                                     as default_rep_high
  from workout_days wd
  left join programs p on p.id = wd.program_id and p.deleted_at is null
  left join program_next pn on pn.program_id = p.id
  left join workout_day_exercises wde on wde.workout_day_id = wd.id
  left join exercises e on e.id = wde.exercise_id
  where wd.deleted_at is null
  order by wd.position, wde.position;
$$;

notify pgrst, 'reload schema';
