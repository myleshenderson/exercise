-- exercise-c9l root-cause fix: ensureSeeded.ts's "read workout_days, seed if
-- empty" check is a check-then-act race. The client-side guards around it
-- (a useRef in App.tsx and a WeakMap in ensureSeeded.ts) only dedupe calls
-- within a single already-running JS process — they do nothing across
-- separate tabs, reloads, or logins, since each starts with fresh in-memory
-- state. Concurrent logins each saw zero existing days and each fully
-- seeded, producing duplicate day templates and catalog exercises with no
-- constraint at any layer to stop it.
--
-- This table turns "has this user already started seeding" into a single
-- atomic, DB-enforced claim: whichever concurrent caller's insert wins the
-- primary key proceeds to seed, and every other caller gets a unique
-- violation and skips seeding entirely. See claimSeed() in src/data/supabase.ts.
create table seed_claims (
  user_id uuid primary key references auth.users(id) default auth.uid()
);

alter table seed_claims enable row level security;

grant select, insert on seed_claims to authenticated;

create policy "own_select" on seed_claims for select using (user_id = auth.uid());
create policy "own_insert" on seed_claims for insert with check (user_id = auth.uid());

-- Backfill: every user who already has at least one day template has
-- necessarily already been seeded (or manually created their own days), so
-- claim seeding as done for them — otherwise their very next login would
-- claim successfully (no row yet) and, if getWorkoutDays() ever raced with
-- their own dashboard load, re-seed on top of existing data.
insert into seed_claims (user_id)
select distinct user_id from workout_days
on conflict (user_id) do nothing;

notify pgrst, 'reload schema';
