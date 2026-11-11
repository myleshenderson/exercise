-- AI-659: serialise sync runs (cron GET, owner POST, `npm run sync`) with a lease row.
-- Two concurrent runs would both refresh the same rotating Peloton refresh token (Auth0
-- reuse detection can then revoke the family) and race on sync_state cursors.
--
-- A lease row rather than a Postgres advisory lock: advisory locks are session-scoped and
-- unreliable through PostgREST's pooled connections. src/sync/lock.ts:
--   acquire  acquire_sync_lock(holder, ttl): one conditional update `where name = 'sync' and
--            lease_until < now()`, true when it took the row (a live lease elsewhere: false;
--            a lapsed one is taken over);
--   renew    renew_sync_lock(holder, ttl) while the run lasts, only while holder still matches;
--   release  in `finally`, a plain update to lease_until = 'epoch', holder = null where holder
--            still matches (clearing holder means a renewal landing late cannot revive it).
-- The functions exist so the comparison and the new lease use the database clock, not the
-- caller's (PostgREST filters take literal values, not now()).
--
-- RLS on with no policies: only service_role (which bypasses RLS) can touch the row. The
-- table postdates 0002's blanket grant, so service_role gets explicit grants.
create table sync_lock (
  name text primary key,
  lease_until timestamptz not null default 'epoch',
  holder text
);

alter table sync_lock enable row level security;

revoke all on sync_lock from anon, authenticated;
grant select, update on sync_lock to service_role;

insert into sync_lock (name) values ('sync') on conflict (name) do nothing;

create function acquire_sync_lock(p_holder text, p_ttl_seconds integer)
returns boolean
language sql
volatile
set search_path = public
as $$
  with taken as (
    update sync_lock
       set lease_until = now() + make_interval(secs => p_ttl_seconds),
           holder = p_holder
     where name = 'sync'
       and lease_until < now()
    returning 1
  )
  select exists (select 1 from taken);
$$;

create function renew_sync_lock(p_holder text, p_ttl_seconds integer)
returns boolean
language sql
volatile
set search_path = public
as $$
  with renewed as (
    update sync_lock
       set lease_until = now() + make_interval(secs => p_ttl_seconds)
     where name = 'sync'
       and holder = p_holder
    returning 1
  )
  select exists (select 1 from renewed);
$$;

revoke all on function acquire_sync_lock(text, integer) from public, anon, authenticated;
revoke all on function renew_sync_lock(text, integer) from public, anon, authenticated;
grant execute on function acquire_sync_lock(text, integer) to service_role;
grant execute on function renew_sync_lock(text, integer) to service_role;

notify pgrst, 'reload schema';
