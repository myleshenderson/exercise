# Day sequencing ("programs") — design

- Bead: `exercise-w8s` ("Add day sequencing ('do X before Y') with an available-day Home screen")
- Depends on: `exercise-w2w` (MCP day-template write tools — shipped), `exercise-k67` (MCP route
  infrastructure — shipped)
- Branch note: this design is written against `origin/main` at `f6cb3c9` (PR #43,
  `exercise-3y9`), which is **ahead of** the `exercise-w8s` branch this spec lives on. That PR
  added `workout_days.deleted_at` and changed `get_day_templates` to filter it out (migration
  `20260906170000_workout_days_soft_delete.sql`). The implementation plan for this spec must
  rebase onto `main` first — the schema and RPC snippets below already assume that soft-delete
  column exists.

## Problem

`workout_days` is a flat, unordered set — `position` is a column that exists but is dead (always
`0`; nothing ever writes another value; see `src/data/supabase.ts`'s `createDay`). There is no way
to express that some days should happen before others, and the Home screen (`src/screens/
Home.tsx`) always shows every day in the program, leaving "what should I do next" to the user's
own memory. A connected MCP client has the same gap: `get_day_templates` returns the same flat
dump, and no write tool can express day-to-day ordering.

Scoping decisions already made (recorded on the bead, confirmed again during this design session):

- **Multiple independent programs**, not one global sequence — a leg-day program and an
  upper-day program don't block each other.
- **Soft suggestion, not a hard block** — a day not yet "next" in its program stays fully
  accessible/loggable out of order; enforcement is about what the Home screen highlights, not a
  data-layer restriction.
- **A program is a one-time, finite progression, not a repeating rotation.** A rotation (e.g. a
  3-day split) doesn't need this feature — the user already knows where they are in a cycle
  they're stepping through themselves. This feature exists for genuine prerequisite structure
  (e.g. "finish the prep-phase days before the strength-phase days") where the finite completion
  state is exactly what isn't obvious from a flat day list. Once every day in a program has been
  completed, the program has nothing further to suggest — no wraparound.
- **MCP support is in scope from the start**, not an afterthought — both read (what's next) and
  write (manage program membership/order) tools.

## Success criteria

- Days can be organized into one or more independent, named programs; a day not assigned to any
  program behaves exactly as all days do today (always available, no ordering implied).
- Completing a day (a logged session with ≥1 exercise, the same predicate `Home.tsx` already uses
  via `getLastSessionForDay`) makes the next day in its program the suggested one — without
  blocking access to any other day.
- The Home screen surfaces the suggested day per program (plus all untracked days) instead of a
  flat list of every day.
- A connected MCP client has equivalent visibility via an extended `get_day_templates`.
- MCP write tools support creating/editing program membership and ordering, not just untracked
  flat days.
- Existing single-user and multi-user (MCP) functionality for untracked programs is unaffected —
  additive, not a breaking change.

## Data model

```sql
create table programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table workout_days
  add column program_id uuid references programs(id) on delete set null,
  add column program_position int;

create unique index workout_days_program_position_uq
  on workout_days (program_id, program_position) where program_id is not null;
```

RLS on `programs` follows the exact `own_select`/`own_insert`/`own_update`/`own_delete` pattern
`workout_days` already has in `0001_init.sql` (`user_id = auth.uid()`), since `programs` is a
top-level table with no parent to check against.

`program_id`/`program_position` stay `null` for untracked days — today's behavior, unaffected.

**Soft delete, matching the `exercise-3y9` precedent.** `delete_program` sets `deleted_at =
now()` rather than deleting the row. Member days' `program_id`/`program_position` are left
untouched — nothing is nulled out, so a program's structure (which days, what order) survives and
can be restored later by clearing `deleted_at`. This preserves the ability to say "you completed
all of Leg Day Progression back in March" after retiring it. All active-path queries (the
`get_day_templates` extension, the Home screen's suggested-day computation) join `programs`
filtered on `deleted_at is null`; a day whose program is soft-deleted is treated as untracked for
surfacing purposes (always accessible, no suggestion badge) without losing the underlying link.

**Why a partial unique index and not a `check` constraint:** positions only need to be unique
*within* a program, and untracked days (`program_id is null`) must be allowed to share
`program_position is null` freely — a plain unique index over both columns would reject that.

## Derivation logic (no stored pointer)

Availability is computed, not stored: for a program, the suggested day is the one with the lowest
`program_position` that has never been completed (no session with ≥1 exercise logged against it,
ever). This always stays consistent with actual session history — no separate write path to keep
in sync, no drift if a session is later deleted, self-healing by construction.

This needs to be computed for two consumers:

1. **The extended `get_day_templates` RPC** (MCP + Home data fetch) — computed in SQL, since the
   RPC already joins everything needed in one round trip.
2. **`src/data/mock.ts`** — computed in JS against the in-memory session list, since the mock
   backend has no SQL layer. `DataLayer`'s two implementations must agree on this predicate, so
   both get unit tests asserting the same cases (empty program → first day available; partially
   done → correct next; fully done → nothing suggested).

RPC shape (extends `0008_full_dump_rpc.sql`'s `get_day_templates`, migration filename following
the `exercise-3y9` timestamp convention, e.g. `20260906180000_day_sequencing.sql`):

```sql
create or replace function public.get_day_templates()
returns table (
  workout_day_id uuid,
  workout_day_name text,
  workout_day_position int,
  program_id uuid,
  program_name text,
  program_position int,
  is_available boolean,       -- new
  exercise_id uuid,
  exercise_name text,
  exercise_cue text,
  exercise_position int,
  target_sets jsonb,
  uses_default_scheme boolean,
  default_sets int,
  default_rep_low int,
  default_rep_high int
)
language sql
stable
security invoker
set search_path = public
as $$
  with day_done as (
    select distinct s.workout_day_id
    from sessions s
    join session_sets ss on ss.session_id = s.id
    where s.workout_day_id is not null
  ),
  program_next as (
    select wd.program_id, min(wd.program_position) as next_position
    from workout_days wd
    left join day_done dd on dd.workout_day_id = wd.id
    where wd.program_id is not null and wd.deleted_at is null and dd.workout_day_id is null
    group by wd.program_id
  )
  select wd.id                                  as workout_day_id,
         wd.name                                as workout_day_name,
         wd.position                            as workout_day_position,
         p.id                                   as program_id,
         p.name                                 as program_name,
         wd.program_position                    as program_position,
         (p.id is null
           or wd.program_position = pn.next_position)  as is_available,
         e.id                                   as exercise_id,
         e.name                                 as exercise_name,
         e.cue                                  as exercise_cue,
         wde.position                           as exercise_position,
         wde.target_sets                        as target_sets,
         wde.target_sets is null                as uses_default_scheme,
         e.default_sets                         as default_sets,
         e.default_rep_low                      as default_rep_low,
         e.default_rep_high                     as default_rep_high
  from workout_days wd
  left join programs p on p.id = wd.program_id and p.deleted_at is null
  left join program_next pn on pn.program_id = p.id
  left join workout_day_exercises wde on wde.workout_day_id = wd.id
  left join exercises e on e.id = wde.exercise_id
  where wd.deleted_at is null
  order by wd.position, wde.position;
$$;
```

(`day_done` intentionally checks `session_sets`, not just `sessions` existing, to match
`getLastSessionForDay`'s "session with ≥1 exercise" predicate rather than counting an empty
in-progress session as complete.)

## Home screen

`Home.tsx`'s query becomes: untracked days (unchanged, always shown) + one suggested-day card per
program, each with a collapsed "show all N days in this program" toggle that reveals the rest
(already-done and not-yet-reached), visually de-emphasized but still fully tappable/loggable via
the existing `start(dayId)` resume-or-create flow — no change to session-creation logic itself,
only to which cards render by default.

## MCP tools

**Read**: `get_day_templates` extended as above — `program_id`, `program_name`,
`program_position`, `is_available` per day row. No new read tool; the existing dump carries the
suggestion signal directly, avoiding a second tool that could drift from it.

**Write** (seven new tools in `api/mcp.ts`, following the exact `withWriteTool`/
`createUserScopedClient` pattern the day-template tools already use):

| Tool | Args | Behavior |
|---|---|---|
| `create_program` | `name: string` | Creates a new program. Returns it, including `id`. |
| `rename_program` | `program_id: string, name: string` | Renames an existing program. |
| `delete_program` | `program_id: string` | Soft-deletes: sets `deleted_at = now()`. Member days keep their `program_id`/`program_position` (not unassigned) — see Data model. |
| `create_day_template` | `name: string`, optional `program_id: string` | Existing tool, extended with an optional program assignment at creation time. Omitted → untracked, unchanged from today. If given, appends the new day to the end of the program using the same next-position logic as `add_day_to_program` below. |
| `add_day_to_program` | `day_id: string, program_id: string` | Assigns an existing (untracked) day to a program, appended at the end (`max(program_position)+1` among that program's current days, or `0` if it has none — same pattern as `addExerciseToDay`'s day-scoped append). Errors if the day already belongs to a program (`"Day <id> is already in program <id>; remove it first."`) rather than silently reassigning it. |
| `remove_day_from_program` | `day_id: string` | Clears the day's `program_id`/`program_position` back to untracked. Touches only that one `workout_days` row — does not renumber the remaining program members (a gap in `program_position` is harmless since the derivation logic only cares about relative order, not contiguity, and `reorder_program_days` fully rewrites positions if the caller wants them tidied). |
| `reorder_program_days` | `program_id: string, day_ids: string[]` | Rewrites the order of a program's **existing** members only — does not add or remove membership. Validates `day_ids` is exactly the program's current membership (same members, any order) before writing, mirroring `reorder_day_exercises`'s set-equality guard; on mismatch, errors naming the missing/extra ids and points at `add_day_to_program`/`remove_day_from_program` instead of silently changing membership. Writes `program_position` as the array index (0..n-1). |

`create_program`/`rename_program`/`delete_program` require existence + ownership checks identical
in style to the day-template tools' (`"Program <id> not found."`); `delete_program` needs no
extra confirmation step, matching `delete_day_template`'s existing "id itself is sufficient"
convention. The membership split (`add_day_to_program`/`remove_day_from_program` for single-row
changes, `reorder_program_days` only for reordering) mirrors the existing
`add_exercise_to_day`/`remove_exercise_from_day`/`reorder_day_exercises` three-way split for
exercises within a day — same narrow-blast-radius reasoning: only the reorder tool does a
multi-row rewrite, and it's guarded by the set-equality check specifically because that's the one
operation broad enough to silently drop data if the caller's list is stale.

## Validation & error handling

- **Every tool taking a `program_id`** (`rename_program`, `delete_program`, `add_day_to_program`,
  `reorder_program_days`, and `create_day_template`'s optional param) treats a soft-deleted
  program as not found — `where deleted_at is null` on the existence check, same
  `"Program <id> not found."` message as a nonexistent id, since a caller has no legitimate reason
  to target a retired program.
- **`reorder_program_days` set-equality check**: mismatch names the missing/extra ids explicitly,
  same convention as `reorder_day_exercises`.
- **Position collisions** are caught by the DB (`workout_days_program_position_uq`) as a defense
  in depth, but `reorder_program_days`'s full-rewrite approach means the application layer should
  never actually trigger it in normal use.
- **`user_id` is never an accepted parameter** on any new write tool — always `default
  auth.uid()` or implied by the RLS-checked row, matching every existing write tool.
- **A day's own soft-delete (`deleted_at`, from `exercise-3y9`) and its program membership are
  independent** — soft-deleting a day does not touch `program_id`/`program_position`, and the
  `get_day_templates` `where wd.deleted_at is null` filter already hides it; no special-casing
  needed in the new program logic.

## RLS coverage

`programs` needs a new migration with the same `own_*` policy set as `workout_days`
(`0001_init.sql`). `workout_days.program_id`/`program_position` are plain columns on an
already-RLS-covered table — no new column-level policy needed, same as any other `workout_days`
column. Since program writes go through `.from("programs").insert/update()` via the existing
user-scoped client (never a new `security definer` RPC), this follows the same "no elevated
privilege" shape as the day-template write tools.

## Testing plan

- **Derivation predicate**: unit tests in both `src/data/mock.test.ts` and against the new SQL
  (via `api/mcp.test.ts`'s fake-client harness, extended with fake `programs`/`program_position`
  data) covering: empty program → first day available; partially completed → correct next;
  fully completed → no day available; untracked days always available regardless of any program
  state.
- **MCP integration tests**: each of the 7 new tools succeeding on a legitimate call;
  cross-user isolation (user A's token can't touch user B's program); `reorder_program_days`'s
  set-mismatch rejection; `add_day_to_program`'s already-in-a-program rejection; a soft-deleted
  program's days reverting to "always available" in `get_day_templates`'s `is_available` output.
- **Home screen**: manual check that untracked-only programs (i.e. today's data) render exactly
  as before — regression check for the "additive, not breaking" success criterion.

## Out of scope

- **Rotation/repeating programs** — explicitly rejected; the user manages rotations themselves
  by picking days in order, and adding sequencing state for that case would be unused complexity.
- **A stored "current position" pointer** — rejected in favor of on-the-fly derivation (see
  Derivation logic) to avoid a second source of truth that can drift from actual session history.
- **Hard delete for programs** — rejected in favor of soft-delete, matching the `exercise-3y9`
  precedent and preserving completed-program history.
- **Branching/DAG day dependencies** (a day depending on more than one predecessor, or multiple
  possible next days) — the bead's own success criteria describe "the next day in its track"
  (singular, linear); a DAG model would be solving a problem not in scope.
