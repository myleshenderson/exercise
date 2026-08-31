-- RPC functions for workout analysis (exercise-k67.5): security-invoker replicas of
-- the workout-analysis skill's ready-made SQL queries, exposed via PostgREST so a
-- caller's own bearer token resolves auth.uid() and the existing RLS policies on
-- session_sets/sessions/exercises scope every result to that caller's own rows.
-- No schema changes; query.sh and the app are unaffected.

create or replace function public.progression_for_exercise(exercise_name text)
returns table (
  performed_on date,
  sets bigint,
  top_weight numeric,
  volume numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select s.performed_on,
         count(*)                        as sets,
         max(ss.weight)                  as top_weight,
         round(sum(ss.weight * ss.reps)) as volume
  from session_sets ss
  join sessions  s on s.id = ss.session_id
  join exercises e on e.id = ss.exercise_id
  where e.name ilike '%' || exercise_name || '%'
  group by s.performed_on
  order by s.performed_on;
$$;

create or replace function public.weekly_volume()
returns table (
  week date,
  sessions bigint,
  total_volume numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select date_trunc('week', s.performed_on)::date as week,
         count(distinct s.id)                     as sessions,
         round(sum(ss.weight * ss.reps))           as total_volume
  from sessions s
  left join session_sets ss on ss.session_id = s.id
  group by 1
  order by 1;
$$;

create or replace function public.training_gaps()
returns table (
  performed_on date,
  days_since_prev int
)
language sql
stable
security invoker
set search_path = public
as $$
  select performed_on,
         performed_on - lag(performed_on) over (order by performed_on) as days_since_prev
  from (select distinct performed_on from sessions) d
  order by performed_on;
$$;

-- PostgREST exposes public-schema functions at /rest/v1/rpc/<name>; only authenticated
-- callers may invoke them (anon has no session, so auth.uid() would be null and RLS
-- would return zero rows anyway, but there's no reason to expose it to anon at all).
grant execute on function public.progression_for_exercise(text) to authenticated;
grant execute on function public.weekly_volume() to authenticated;
grant execute on function public.training_gaps() to authenticated;

notify pgrst, 'reload schema';
