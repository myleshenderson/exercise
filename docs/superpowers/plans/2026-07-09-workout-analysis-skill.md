# Workout Analysis Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project-level Claude Code skill that lets the user conversationally explore their workout data via read-only SQL against the hosted Supabase Postgres database.

**Architecture:** Two files in `.claude/skills/workout-analysis/`: a `query.sh` wrapper that is the single audited path to the database (sources `SUPABASE_PASSWORD` from the repo's `.env.local`, connects with session-level `default_transaction_read_only=on`), and a `SKILL.md` that documents the schema and ready-made analysis queries. No schema changes, no new dependencies.

**Tech Stack:** Bash, psql (PostgreSQL client, already installed), Claude Code skill format (SKILL.md with YAML frontmatter).

## Global Constraints

- Work happens on the existing branch `feat/workout-analysis-skill` (already created from main).
- Read-only is enforced via `options=-c default_transaction_read_only=on` in the psql connection URI — session level, not per-statement.
- Only `SUPABASE_PASSWORD` is secret; the project ref `<project-ref>` is public (already shipped in the client bundle) and is hardcoded in `query.sh`.
- `.env.local` is gitignored; the skill must fail with an explicit message when it is missing.
- Do not start or stop dev servers.
- Run `npm run typecheck` (or the project's typecheck script per package.json) before opening a PR — even though this change is shell + markdown, the user's rule is unconditional.
- Commit as the repo-local identity (Myles Henderson / <owner email> — already configured).

---

### Task 1: query.sh — read-only psql wrapper

**Files:**
- Create: `.claude/skills/workout-analysis/query.sh`

**Interfaces:**
- Consumes: `SUPABASE_PASSWORD` from `<repo>/.env.local`; `psql` on PATH.
- Produces: executable `query.sh` that Task 2's SKILL.md instructs Claude to call. Usage contract: `query.sh "SELECT ..."` (SQL as first argument) or `echo "SELECT ..." | query.sh` (SQL on stdin). Exit 0 with tabular results on stdout; non-zero with the Postgres error on stderr on failure.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Read-only query runner for the exercise app's Supabase database.
# Usage: query.sh "SELECT ..."   or   echo "SELECT ..." | query.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — it must contain SUPABASE_PASSWORD (gitignored, so absent on fresh clones)" >&2
  exit 1
fi

SUPABASE_PASSWORD="$(grep -E '^SUPABASE_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
if [[ -z "$SUPABASE_PASSWORD" ]]; then
  echo "error: SUPABASE_PASSWORD not set in $ENV_FILE" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql not found on PATH (brew install libpq or postgresql)" >&2
  exit 1
fi

# options=-c default_transaction_read_only=on (URI-encoded) makes the whole
# session read-only; any INSERT/UPDATE/DELETE/DDL errors out server-side.
CONN="postgresql://postgres@db.<project-ref>.supabase.co:5432/postgres?options=-c%20default_transaction_read_only%3Don"

if [[ $# -ge 1 ]]; then
  exec env PGPASSWORD="$SUPABASE_PASSWORD" PGCONNECT_TIMEOUT=10 \
    psql "$CONN" --set=ON_ERROR_STOP=1 -P pager=off -c "$1"
else
  exec env PGPASSWORD="$SUPABASE_PASSWORD" PGCONNECT_TIMEOUT=10 \
    psql "$CONN" --set=ON_ERROR_STOP=1 -P pager=off -f -
fi
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x .claude/skills/workout-analysis/query.sh`

- [ ] **Step 3: Verify a read works (from an unrelated cwd, to prove path resolution)**

Run: `cd /tmp && /Users/myleshenderson/src/exercise/.claude/skills/workout-analysis/query.sh "SELECT count(*) AS sessions FROM sessions;"`
Expected: a one-row result, e.g. ` sessions \n----------\n        8`; exit code 0.

- [ ] **Step 4: Verify a write is rejected**

Run: `.claude/skills/workout-analysis/query.sh "INSERT INTO workout_days (user_id, name, position) VALUES (gen_random_uuid(), 'should-fail', 99);"`
Expected: FAIL — stderr contains `cannot execute INSERT in a read-only transaction`; non-zero exit code. No row is created.

- [ ] **Step 5: Verify stdin mode works**

Run: `echo "SELECT name FROM exercises ORDER BY name LIMIT 3;" | .claude/skills/workout-analysis/query.sh`
Expected: three exercise names (e.g. Bicep Curl, Chest Press, Core Crunch); exit code 0.

- [ ] **Step 6: Verify the missing-password error path**

Run: `SCRIPT=.claude/skills/workout-analysis/query.sh; TMPDIR_FAKE=$(mktemp -d) && mkdir -p "$TMPDIR_FAKE/.claude/skills/workout-analysis" && cp "$SCRIPT" "$TMPDIR_FAKE/.claude/skills/workout-analysis/" && "$TMPDIR_FAKE/.claude/skills/workout-analysis/query.sh" "SELECT 1;" ; echo "exit=$?"; rm -rf "$TMPDIR_FAKE"`
Expected: `error: .../.env.local not found — it must contain SUPABASE_PASSWORD ...` on stderr and `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/workout-analysis/query.sh
git commit -m "feat: read-only psql wrapper for workout-analysis skill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: SKILL.md — the skill document

**Files:**
- Create: `.claude/skills/workout-analysis/SKILL.md`

**Interfaces:**
- Consumes: `query.sh` from Task 1 (usage contract: SQL as `$1` or stdin; read-only session).
- Produces: a skill discoverable by the Skill tool as `workout-analysis`.

- [ ] **Step 1: Write SKILL.md**

````markdown
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
````

- [ ] **Step 2: Validate every SQL block in SKILL.md against the live DB**

Run each of the three queries through the wrapper, e.g.:
`.claude/skills/workout-analysis/query.sh "SELECT s.performed_on, count(*) AS sets, max(ss.weight) AS top_weight, round(sum(ss.weight * ss.reps)) AS volume FROM session_sets ss JOIN sessions s ON s.id = ss.session_id JOIN exercises e ON e.id = ss.exercise_id WHERE e.name ILIKE '%leg press%' GROUP BY s.performed_on ORDER BY s.performed_on;"`
Expected: each returns rows (progression: ≥1 row for leg press; weekly volume: ≥1 week; gaps: one row per distinct workout date) with exit code 0. If any errors, fix the SQL in SKILL.md and re-run.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/workout-analysis/SKILL.md
git commit -m "feat: workout-analysis skill for conversational progress queries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Final verification and PR

**Files:**
- None created/modified (verification only).

**Interfaces:**
- Consumes: both files from Tasks 1–2 on branch `feat/workout-analysis-skill`.
- Produces: an open PR against main.

- [ ] **Step 1: Run the typecheck**

Run: `npm run typecheck` (check `package.json` scripts for the exact name; if only `tsc -b` or `build` exists, run that).
Expected: exit 0, no errors (this change touches no TypeScript, but the rule is unconditional before a PR).

- [ ] **Step 2: Smoke-test the skill end-to-end as Claude would use it**

Run: `.claude/skills/workout-analysis/query.sh "SELECT e.name, max(ss.weight) AS top_weight FROM session_sets ss JOIN exercises e ON e.id = ss.exercise_id GROUP BY e.name ORDER BY top_weight DESC NULLS LAST LIMIT 5;"`
Expected: top-5 heaviest exercises with weights; exit 0.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/workout-analysis-skill
gh pr create --title "feat: workout-analysis skill (read-only DB queries)" --body "Adds a project skill at .claude/skills/workout-analysis/: a read-only psql wrapper (session-level default_transaction_read_only=on, password sourced from gitignored .env.local) and a SKILL.md with schema notes and ready-made progression/volume/consistency queries, so Claude can discuss workout progress conversationally.

Verified: reads succeed from any cwd, INSERT is rejected by the read-only session, missing .env.local fails with an explicit error, and all SKILL.md queries run against the live DB.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR URL printed.

- [ ] **Step 4: Note for the user (not automatable)**

Skill discoverability (`workout-analysis` appearing in the Skill tool list) requires a fresh Claude Code session in this repo — ask the user to verify by asking "how's my leg press going?" in a new session after merge.
