-- Harden write policies on the child tables so a row's foreign keys must point at
-- parent rows the SAME user owns — not just that the new row is stamped with the
-- caller's user_id. Prevents an authenticated user from attaching rows to another
-- user's day/session/exercise even if they knew its UUID.
--
-- exercises and workout_days are top-level (no parent) and keep their 0001 policies.

-- workout_day_exercises: day + exercise must both belong to the caller.
drop policy "own_insert" on workout_day_exercises;
create policy "own_insert" on workout_day_exercises for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from workout_days wd where wd.id = workout_day_id and wd.user_id = auth.uid())
    and exists (select 1 from exercises e where e.id = exercise_id and e.user_id = auth.uid())
  );

drop policy "own_update" on workout_day_exercises;
create policy "own_update" on workout_day_exercises for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from workout_days wd where wd.id = workout_day_id and wd.user_id = auth.uid())
    and exists (select 1 from exercises e where e.id = exercise_id and e.user_id = auth.uid())
  );

-- sessions: workout_day_id is nullable (blank session); if set, it must be the caller's.
drop policy "own_insert" on sessions;
create policy "own_insert" on sessions for insert
  with check (
    user_id = auth.uid()
    and (
      workout_day_id is null
      or exists (select 1 from workout_days wd where wd.id = workout_day_id and wd.user_id = auth.uid())
    )
  );

drop policy "own_update" on sessions;
create policy "own_update" on sessions for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (
      workout_day_id is null
      or exists (select 1 from workout_days wd where wd.id = workout_day_id and wd.user_id = auth.uid())
    )
  );

-- session_sets: session + exercise must both belong to the caller.
drop policy "own_insert" on session_sets;
create policy "own_insert" on session_sets for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from sessions s where s.id = session_id and s.user_id = auth.uid())
    and exists (select 1 from exercises e where e.id = exercise_id and e.user_id = auth.uid())
  );

drop policy "own_update" on session_sets;
create policy "own_update" on session_sets for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from sessions s where s.id = session_id and s.user_id = auth.uid())
    and exists (select 1 from exercises e where e.id = exercise_id and e.user_id = auth.uid())
  );
