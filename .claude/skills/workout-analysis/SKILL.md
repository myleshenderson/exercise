---
name: workout-analysis
description: Myles's own local-dev/debugging tool for poking at the exercise app's Supabase schema directly via superuser SQL. NOT for conversational workout analysis and NOT safe to use now that a second user's data exists in the tables — query.sh connects as the postgres superuser and bypasses row-level security, so it returns every user's rows undifferentiated. For "how's my leg press going" / progress / volume / consistency questions, use the app's MCP tools instead (progression_for_exercise, weekly_volume, training_gaps, get_day_templates, get_workout_history, sets_for_exercise), which are per-user scoped.
---

# Workout Analysis (local dev/debug only — do not use for user-facing analysis)

> **Superuser access. Local development only.** `query.sh` connects to the
> production Supabase database as the `postgres` superuser, which **bypasses
> row-level security**. It was written back when Myles's own account was the
> only row in every table. That is no longer true — a second real user's
> workout data now exists in these tables — so any query here returns rows
> from every user, unscoped and indistinguishable from each other.
>
> **Do not invoke this skill to answer a user's workout questions.** Use the
> MCP tools (`progression_for_exercise`, `weekly_volume`, `training_gaps`,
> `get_day_templates`, `get_workout_history`, `sets_for_exercise`, exposed via
> `api/mcp.ts`) for anything conversational — they authenticate the caller
> and are scoped to that user's own data via RLS/`SECURITY INVOKER` RPCs.
> This skill is only appropriate for Myles personally debugging schema/data
> issues from his own machine, and even then, results may contain other
> users' data — filter by `user_id` by hand and do not surface other users'
> rows.

Explore workout data by querying the hosted Supabase Postgres database
directly. This skill is **read-only**: run SELECT queries only; never modify
data or schema, and never connect to the database except through `query.sh`.

## Requirements

- `<repo>/.env.local` must exist and contain `SUPABASE_PASSWORD` (the
  database password) and `SUPABASE_DB_HOST` (the full database hostname,
  e.g. `db.<project-ref>.supabase.co`). The file is gitignored, so it is
  absent on fresh clones — if `query.sh` reports either missing, tell the
  user rather than working around it.
- `psql` on PATH.

## How to query

Always use the wrapper (path relative to repo root). It refuses to run
unless `ALLOW_SUPERUSER_QUERY=1` is set, so it can't fire by accident — only
set that when Myles is intentionally debugging locally:

```bash
ALLOW_SUPERUSER_QUERY=1 .claude/skills/workout-analysis/query.sh "SELECT ..."
# or, for multi-statement / long SQL:
echo "WITH ..." | ALLOW_SUPERUSER_QUERY=1 .claude/skills/workout-analysis/query.sh
```

The session is forced read-only server-side; a write attempt errors with
"cannot execute ... in a read-only transaction". If a query fails, read the
stderr, fix the SQL, and retry.

## Schema

Five tables, all user-scoped by `user_id` (no longer single-user data — a
second real user now exists; always filter/group by `user_id` and never
report one user's data as if it belonged to another):

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

These apply when Myles is debugging his own data locally — not to
user-facing conversational analysis, which should go through the MCP tools
instead (see the warning at the top of this file):

- Answer in plain language with small tables or short trend statements —
  not raw SQL dumps and not the SQL itself unless asked.
- Compare like with like: same exercise across sessions, or same week metric
  over weeks.
- Be honest about sparse data: with only a handful of sessions, say "early
  signal", not "trend".
- Two of the seeded sessions (2026-06-18, 2026-06-20) are demo data created
  at first login; mention this if they would skew an analysis of real
  training history.
- Always check `user_id` yourself — the query results are not scoped to a
  single user, so don't assume every row belongs to the person you're
  helping.
