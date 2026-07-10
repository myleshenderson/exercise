---
name: workout-analysis
description: Use when the user wants to talk about their workouts, exercises, training progress, strength gains, volume, or consistency (e.g. "how's my leg press going", "am I training enough", "talk about my progress") — queries the exercise app's Supabase database read-only.
---

# Workout Analysis

Explore the user's workout data conversationally by querying their hosted
Supabase Postgres database. This skill is **read-only**: run SELECT queries
only; never modify data or schema, and never connect to the database except
through `query.sh`.

## Requirements

- `<repo>/.env.local` must exist and contain `SUPABASE_PASSWORD` (it is
  gitignored, so it is absent on fresh clones — if `query.sh` reports it
  missing, tell the user rather than working around it).
- `psql` on PATH.

## How to query

Always use the wrapper (path relative to repo root):

```bash
.claude/skills/workout-analysis/query.sh "SELECT ..."
# or, for multi-statement / long SQL:
echo "WITH ..." | .claude/skills/workout-analysis/query.sh
```

The session is forced read-only server-side; a write attempt errors with
"cannot execute ... in a read-only transaction". If a query fails, read the
stderr, fix the SQL, and retry.

## Schema

Five tables, all user-scoped by `user_id` (single-user data in practice):

- `exercises` — id, name, cue, default_sets, default_rep_low, default_rep_high
- `workout_days` — id, name, position (day templates, e.g. "Leg Day")
- `workout_day_exercises` — workout_day_id → exercise_id, position (template contents)
- `sessions` — id, workout_day_id (nullable), performed_on (date)
- `session_sets` — session_id, exercise_id, set_number, weight (numeric), reps (int)

Join path for analysis: `sessions → session_sets → exercises`, dated by
`sessions.performed_on`. Weight is unitless — report it as the user logs it.
Session "volume" = Σ (weight × reps).

## Ready-made queries

**Progression for one exercise** (substitute the exercise name):

```sql
SELECT s.performed_on,
       count(*)                AS sets,
       max(ss.weight)          AS top_weight,
       round(sum(ss.weight * ss.reps)) AS volume
FROM session_sets ss
JOIN sessions  s ON s.id = ss.session_id
JOIN exercises e ON e.id = ss.exercise_id
WHERE e.name ILIKE '%leg press%'
GROUP BY s.performed_on
ORDER BY s.performed_on;
```

**Weekly volume & consistency:**

```sql
SELECT date_trunc('week', s.performed_on)::date AS week,
       count(DISTINCT s.id)                     AS sessions,
       round(sum(ss.weight * ss.reps))          AS total_volume
FROM sessions s
LEFT JOIN session_sets ss ON ss.session_id = s.id
GROUP BY 1
ORDER BY 1;
```

**Training gaps** (days between consecutive workout dates):

```sql
SELECT performed_on,
       performed_on - lag(performed_on) OVER (ORDER BY performed_on) AS days_since_prev
FROM (SELECT DISTINCT performed_on FROM sessions) d
ORDER BY performed_on;
```

Anything else (PRs, per-set detail, day-template comparisons) is fine as
freeform SELECTs through the same wrapper.

## How to talk about results

- Answer in plain language with small tables or short trend statements —
  not raw SQL dumps and not the SQL itself unless asked.
- Compare like with like: same exercise across sessions, or same week metric
  over weeks.
- Be honest about sparse data: with only a handful of sessions, say "early
  signal", not "trend".
- Two of the seeded sessions (2026-06-18, 2026-06-20) are demo data created
  at first login; mention this if they would skew an analysis of real
  training history.
