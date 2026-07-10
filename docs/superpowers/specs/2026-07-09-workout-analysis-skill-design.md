# Workout Analysis Skill — Design

**Date:** 2026-07-09
**Status:** Approved

## Purpose

A project-level Claude Code skill that lets the user conversationally explore
their workout data and progress ("how's my leg press going?", "am I training
consistently?") by querying the hosted Supabase Postgres database directly,
read-only.

## Decisions

- **Location:** project skill in `.claude/skills/workout-analysis/` in this
  repo. Credentials come from the repo's `.env.local`; the skill is only
  invocable from this repo.
- **Read-only guarantee:** every connection sets
  `default_transaction_read_only = on` at the session level via the wrapper
  script, so writes error out. Not tamper-proof, but structural rather than
  behavioral.
- **Focus analyses:** progression per exercise, and volume & consistency.
  Everything else remains possible via freeform SQL through the same wrapper.
- **No schema changes:** no views, roles, or migrations. All analysis is done
  with plain SELECTs (CTEs as needed) against the existing 5 tables.

## Layout

```
.claude/skills/workout-analysis/
├── SKILL.md      # the skill itself
└── query.sh      # read-only psql wrapper
```

## Components

### query.sh

A small shell script; the single audited path for all database access.

- Accepts SQL as `$1` or on stdin.
- Locates `.env.local` relative to the script's own path (works from any cwd)
  and sources `SUPABASE_PASSWORD` from it.
- Connects with `psql` to
  `db.aeolejvpsavbbmluysnm.supabase.co:5432/postgres` as `postgres`, with
  `options=-c default_transaction_read_only=on` in the connection string so
  the whole session is read-only.
- Uses `ON_ERROR_STOP=1` and `-P pager=off`; exits non-zero with stderr
  passed through so failed SQL is visible and correctable.
- Fails with a clear message if `.env.local` or `SUPABASE_PASSWORD` is
  missing.
- The project ref is hardcoded (it is already public in the client bundle);
  only the password is secret and stays in the gitignored `.env.local`.

### SKILL.md

- **Frontmatter description** tuned to trigger on conversational asks about
  workouts and progress ("how's my bench going", "talk about my workouts",
  "am I training enough").
- **Requirements note** at the top: depends on `.env.local` with
  `SUPABASE_PASSWORD` (gitignored — must exist locally; fails loudly
  otherwise) and `psql` on PATH.
- **How to query:** always via `query.sh`; SELECT-only; never modify data or
  schema.
- **Schema cheat-sheet:** the 5 tables (`exercises`, `workout_days`,
  `workout_day_exercises`, `sessions`, `session_sets`), key columns, join
  path (`sessions → session_sets → exercises`; dates on
  `sessions.performed_on`; weights are unitless — whatever the user logs).
- **Ready-made queries:**
  - *Progression per exercise:* per-session top weight, sets, and volume over
    time, filterable by exercise name.
  - *Volume & consistency:* weekly total volume (Σ weight×reps), sessions per
    week, and training-gap detection.
- **Conversation guidance:** answer in plain language with small tables and
  trends, not raw SQL dumps; call out when data is too sparse to support a
  trend claim.

## Error handling

Wrapper propagates psql's exit code and stderr. Read-only violations surface
as Postgres errors by design (`cannot execute INSERT in a read-only
transaction`). Missing prerequisites (env file, password, psql) produce
explicit messages.

## Testing

1. Run `query.sh` with the progression query; confirm real rows return.
2. Attempt an `INSERT` through the wrapper; confirm Postgres rejects it.
3. Confirm the skill is discoverable by the Skill tool in a fresh session.
