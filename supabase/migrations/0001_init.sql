-- Exercises catalog
create table exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  cue text not null default '',
  default_sets int not null default 3,
  default_rep_low int not null default 10,
  default_rep_high int not null default 12,
  created_at timestamptz not null default now()
);

create table workout_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table workout_day_exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  workout_day_id uuid not null references workout_days(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  position int not null default 0
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  workout_day_id uuid references workout_days(id) on delete set null,
  performed_on date not null,
  created_at timestamptz not null default now()
);

create table session_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  session_id uuid not null references sessions(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  set_number int not null,
  weight numeric not null,
  reps int not null
);

-- Enable RLS + per-user policies
do $$
declare t text;
begin
  foreach t in array array['exercises','workout_days','workout_day_exercises','sessions','session_sets']
  loop
    execute format('alter table %I enable row level security;', t);
    execute format($p$create policy "own_select" on %I for select using (user_id = auth.uid());$p$, t);
    execute format($p$create policy "own_insert" on %I for insert with check (user_id = auth.uid());$p$, t);
    execute format($p$create policy "own_update" on %I for update using (user_id = auth.uid()) with check (user_id = auth.uid());$p$, t);
    execute format($p$create policy "own_delete" on %I for delete using (user_id = auth.uid());$p$, t);
  end loop;
end $$;
