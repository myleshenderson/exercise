-- Optional per-(day, exercise) progressive set scheme: an ordered list of
-- {weight, reps} pairs that overrides the exercise's uniform default-sets
-- behavior when starting a session for that day. Null means "no scheme —
-- use the exercise's defaultSets/defaultRepLow/defaultRepHigh as before".
alter table workout_day_exercises add column target_sets jsonb;
