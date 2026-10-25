-- Soft-delete support for exercises (exercise-2bv): delete_exercise marks a
-- catalog exercise deleted_at instead of removing the row, mirroring
-- workout_days' soft-delete pattern (20260906170000_workout_days_soft_delete.sql).
-- delete_exercise itself refuses to soft-delete an exercise that's still
-- attached to a day or referenced by logged session_sets/scheme_history, so
-- no row surfaced elsewhere (e.g. via get_day_templates) can ever point at a
-- deleted exercise. list_exercises excludes soft-deleted exercises so they
-- don't reappear in normal listings.

alter table exercises add column deleted_at timestamptz;
