-- Ride analytics, wave 1 (AI-631, epic AI-627): storage for Garmin, Peloton
-- and Strava-export rides, their 1 Hz streams, Garmin weigh-ins, athlete
-- settings, FTP history, the daily CTL/ATL/TSB series and sync bookkeeping.
-- Ingestion (wave 2) and screens (wave 3) build on these tables.
--
-- Grants: every table here postdates 0002's blanket grant (which only covered
-- tables that existed when it ran; see 20260906151951_scheme_history.sql and
-- 0009_grant_mcp_sessions_service_role.sql), so each one gets explicit grants.
-- service_role is granted too because the wave 2 sync writes through the
-- service-role client: bypassing RLS does not skip the table-level GRANT check.
--
-- updated_at has no trigger; the DataLayer write helpers stamp it.

-- ---------------------------------------------------------------------------
-- external_activities: one row per provider activity (a ride).
-- TSS, IF and NP in the typed columns are always computed by our own maths
-- module, never copied from Garmin. The provider's own summary object is kept
-- unmodified in provider_payload (Garmin trainingStressScore, intensityFactor,
-- maxAvgPower_*; Peloton ftp_info) and never promoted into typed columns.
-- ---------------------------------------------------------------------------
create table external_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  source text not null check (source in ('garmin', 'peloton', 'strava_export')),
  source_id text not null,
  started_at timestamptz not null,
  timezone text,
  sport text not null,
  sub_type text,
  environment text not null check (environment in ('indoor', 'outdoor')),
  title text,
  elapsed_s double precision,
  moving_s double precision,
  distance_m double precision,
  elevation_gain_m double precision,
  avg_speed_mps double precision,
  max_speed_mps double precision,
  avg_power_w double precision,
  max_power_w double precision,
  normalized_power_w double precision,
  intensity_factor double precision,
  tss double precision,
  work_kj double precision,
  calories double precision,
  avg_hr_bpm double precision,
  max_hr_bpm double precision,
  avg_cadence_rpm double precision,
  biggest_climb_m double precision,
  tss_source text check (tss_source in ('power', 'estimated_flat')),
  ftp_used_w integer,
  ftp_source text,
  has_power boolean not null default false,
  has_hr boolean not null default false,
  power_curve jsonb,
  best_efforts jsonb,
  paired_activity_id uuid references external_activities(id) on delete set null,
  provider_payload jsonb not null,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, source_id)
);

comment on column external_activities.started_at is 'UTC instant the activity started.';
comment on column external_activities.timezone is 'IANA zone name exactly as the provider gives it (e.g. Etc/GMT+5); only Garmin detail carries one.';
comment on column external_activities.sub_type is 'Garmin typeKey or Peloton fitness_discipline.';
comment on column external_activities.tss_source is 'power: TSS from the power stream; estimated_flat: no power, athlete_settings.no_power_tss_per_hour x hours (decision 16). Null when no TSS yet.';
comment on column external_activities.provider_payload is 'The provider''s own summary object, unmodified. Garmin TSS/IF/maxAvgPower_* and Peloton ftp_info live here, never in typed columns.';

create index external_activities_user_started_idx on external_activities (user_id, started_at desc);

alter table external_activities enable row level security;

grant select, insert, update, delete on external_activities to authenticated;
grant select, insert, update, delete on external_activities to service_role;

create policy "own_select" on external_activities for select using (user_id = auth.uid());
create policy "own_insert" on external_activities for insert with check (user_id = auth.uid());
create policy "own_update" on external_activities for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on external_activities for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- activity_streams: one row per (activity, channel). values[i] is second i
-- after started_at + start_offset_s at 1 Hz; a missing second is a SQL NULL
-- element. real[] rather than jsonb: 4 bytes per sample with native NULL
-- gaps, TOAST-compressed, and PostgREST returns it as a plain JSON array,
-- where jsonb would store every number as numeric at several times the size.
-- "values" is quoted because VALUES is a reserved word; PostgREST quotes it
-- itself, so clients still use the plain name.
-- ---------------------------------------------------------------------------
create table activity_streams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  activity_id uuid not null references external_activities(id) on delete cascade,
  channel text not null check (channel in ('power', 'heart_rate', 'cadence', 'speed', 'distance', 'altitude', 'lat', 'lng', 'temperature', 'resistance')),
  start_offset_s integer not null default 0,
  "values" real[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (activity_id, channel)
);

alter table activity_streams enable row level security;

grant select, insert, update, delete on activity_streams to authenticated;
grant select, insert, update, delete on activity_streams to service_role;

create policy "own_select" on activity_streams for select using (user_id = auth.uid());
create policy "own_insert" on activity_streams for insert with check (user_id = auth.uid());
create policy "own_update" on activity_streams for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on activity_streams for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- body_weights: Garmin weigh-ins. source_id is Garmin's samplePk.
-- measured_at comes from timestampGMT, never from date (local wall clock).
-- ---------------------------------------------------------------------------
create table body_weights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  source text not null check (source in ('garmin')),
  source_id text not null,
  measured_at timestamptz not null,
  weight_kg double precision not null,
  bmi double precision,
  body_fat_pct double precision,
  body_water_pct double precision,
  muscle_mass_kg double precision,
  bone_mass_kg double precision,
  provider_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, source_id)
);

comment on column body_weights.source_id is 'Garmin samplePk.';
comment on column body_weights.measured_at is 'From Garmin timestampGMT, never from date (local wall clock).';
comment on column body_weights.weight_kg is 'Garmin sends grams; the ingester divides by 1000';
comment on column body_weights.muscle_mass_kg is 'Garmin sends grams; the ingester divides by 1000';
comment on column body_weights.bone_mass_kg is 'Garmin sends grams; the ingester divides by 1000';

create index body_weights_user_measured_idx on body_weights (user_id, measured_at);

alter table body_weights enable row level security;

grant select, insert, update, delete on body_weights to authenticated;
grant select, insert, update, delete on body_weights to service_role;

create policy "own_select" on body_weights for select using (user_id = auth.uid());
create policy "own_insert" on body_weights for insert with check (user_id = auth.uid());
create policy "own_update" on body_weights for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on body_weights for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- athlete_settings: one row per user, keyed by user_id (no id column). A
-- missing row means every column default applies.
-- ---------------------------------------------------------------------------
create table athlete_settings (
  user_id uuid primary key references auth.users(id) default auth.uid(),
  manual_ftp_w integer,
  lthr_bpm integer,
  max_hr_bpm integer,
  resting_hr_bpm integer,
  strength_session_tss numeric not null default 50,
  no_power_tss_per_hour numeric not null default 55,
  units text not null default 'imperial' check (units in ('imperial', 'metric')),
  week_start text not null default 'monday' check (week_start in ('monday', 'sunday')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column athlete_settings.manual_ftp_w is 'Null means use the estimated FTP (decision 10).';
comment on column athlete_settings.strength_session_tss is 'TSS credited per strength session (decision 7).';
comment on column athlete_settings.no_power_tss_per_hour is 'Flat TSS per hour for rides without power (decision 16).';

alter table athlete_settings enable row level security;

grant select, insert, update, delete on athlete_settings to authenticated;
grant select, insert, update, delete on athlete_settings to service_role;

create policy "own_select" on athlete_settings for select using (user_id = auth.uid());
create policy "own_insert" on athlete_settings for insert with check (user_id = auth.uid());
create policy "own_update" on athlete_settings for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on athlete_settings for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- ftp_history: every FTP value and when it took effect.
-- Peloton mapping (applied by the wave 2 ingester):
--   ftp_workout_source -> 'peloton_test'
--   ftp_manual_source  -> 'peloton_manual'
-- source_ref holds the Peloton workout id when there is one.
-- ---------------------------------------------------------------------------
create table ftp_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  effective_from timestamptz not null,
  ftp_w integer not null check (ftp_w > 0),
  source text not null check (source in ('manual', 'peloton_test', 'peloton_manual', 'estimated')),
  source_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, effective_from, source)
);

alter table ftp_history enable row level security;

grant select, insert, update, delete on ftp_history to authenticated;
grant select, insert, update, delete on ftp_history to service_role;

create policy "own_select" on ftp_history for select using (user_id = auth.uid());
create policy "own_insert" on ftp_history for insert with check (user_id = auth.uid());
create policy "own_update" on ftp_history for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on ftp_history for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- daily_training_load: one row per user per local calendar day.
-- tsb = ctl - atl of the same day (decision 6), not of the previous day.
-- tss_by_source keys: garmin, peloton, strava_export, strength.
-- ---------------------------------------------------------------------------
create table daily_training_load (
  user_id uuid not null references auth.users(id) default auth.uid(),
  date date not null,
  tss_total double precision not null default 0,
  tss_by_source jsonb not null default '{}',
  ctl double precision not null,
  atl double precision not null,
  tsb double precision not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

comment on column daily_training_load.date is 'Local calendar day.';
comment on column daily_training_load.tsb is 'tsb = ctl - atl of the same day (decision 6).';
comment on column daily_training_load.tss_by_source is 'Keys: garmin, peloton, strava_export, strength.';

alter table daily_training_load enable row level security;

grant select, insert, update, delete on daily_training_load to authenticated;
grant select, insert, update, delete on daily_training_load to service_role;

create policy "own_select" on daily_training_load for select using (user_id = auth.uid());
create policy "own_insert" on daily_training_load for insert with check (user_id = auth.uid());
create policy "own_update" on daily_training_load for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on daily_training_load for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- sync_state: per-user, per-feed sync bookkeeping. Clients only read it
-- (Settings shows status and the reconnect prompt); the wave 2 sync writes
-- it through the service role. Hence only own_select, select-only for
-- authenticated, and no delete for anyone.
-- ---------------------------------------------------------------------------
create table sync_state (
  user_id uuid not null references auth.users(id) default auth.uid(),
  source text not null check (source in ('garmin_activities', 'garmin_weight', 'peloton')),
  cursor jsonb,
  last_run_at timestamptz,
  last_success_at timestamptz,
  items_fetched integer not null default 0,
  items_upserted integer not null default 0,
  last_error text,
  backfill_complete boolean not null default false,
  auth_status text not null default 'ok' check (auth_status in ('ok', 'reconnect_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table sync_state enable row level security;

grant select on sync_state to authenticated;
grant select, insert, update on sync_state to service_role;

create policy "own_select" on sync_state for select using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- provider_credentials: encrypted provider tokens (Peloton Auth0 tokens).
-- Same shape of protection as mcp_sessions (0004/0009): RLS on with NO
-- policies, so anon/authenticated can never read it even if a grant slipped
-- in, and grants only to service_role. The database only ever sees
-- ciphertext: encryption (decision 14) is AES-256-GCM in the Vercel function
-- with node:crypto, key from a Vercel env var named in wave 2 (key_id says
-- which key). ciphertext, iv and auth_tag are base64.
-- ---------------------------------------------------------------------------
create table provider_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  provider text not null check (provider in ('peloton')),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_id text not null,
  access_expires_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

alter table provider_credentials enable row level security;

grant select, insert, update, delete on provider_credentials to service_role;

notify pgrst, 'reload schema';
