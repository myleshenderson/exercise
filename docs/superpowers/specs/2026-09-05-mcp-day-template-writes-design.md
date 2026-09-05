# MCP day-template write tools — design

- Bead: `exercise-w2w` ("Add write/management tools to the MCP route (log workouts, manage days)")
- Depends on: `exercise-k67` (MCP route, login/token, session-store infrastructure — shipped)
- Scope decision: this spec covers **day-template management only**. Logging a workout
  session (creating a session + sets) is explicitly out of scope and left for a future bead —
  see "Out of scope" below.

## Problem

`exercise-k67` shipped a read-only MCP route: a connected client can query a user's own
workout data (progression, weekly volume, training gaps, day templates, full history) via six
`security invoker` RPC-backed tools in `api/mcp.ts`, scoped to the caller by presenting their
resolved Supabase access token as the `Authorization` header on a service-role-keyed client
(`createUserScopedClient`). No MCP tool can currently *write* anything — a user can't create,
edit, or delete a day template (or its exercises) through their MCP client; that's still
app-only, via `src/screens/ManageDays.tsx`.

This spec adds day-template write tools on the same infrastructure. The bead's success
criteria specifically call out the risk that write tools driven by an LLM's interpretation of
a natural-language request are higher-risk than the read-only case — mirroring the eager-write
bug fixed in `exercise-db9`, where tapping into a day unconditionally created a new session row
with no resume-lookup, producing junk data. This design's guardrails (id-only targeting, narrow
per-tool blast radius, explicit validation errors instead of silent partial writes) exist to
prevent the equivalent failure mode for day-template writes.

## Success criteria

- A connected MCP client can fully manage a user's day templates: create, rename, and delete
  a day; create catalog exercises; attach/detach/reorder a day's exercises; set or clear a
  day's per-exercise rep/weight scheme.
- Every write is scoped to the caller's own resolved identity via the same RLS-respecting
  approach as the existing read tools — no write can ever affect another user's data.
- No tool accepts a name and guesses which row it refers to. Every write targets an existing
  day or exercise by id; callers resolve names to ids via the existing `get_day_templates` read
  tool first. This eliminates the ambiguous-match failure mode entirely rather than mitigating
  it with fuzzy-matching heuristics.
- No tool silently drops or corrupts existing data as a side effect of an unrelated edit — in
  particular, a day's per-exercise `target_sets` scheme must survive membership/order changes,
  and reordering a day's exercises must not silently add or remove membership.
- New write logic reuses the existing, tested query logic in `src/data/supabase.ts` rather than
  reimplementing it a second time in `api/mcp.ts` or a third time in SQL.

## Tool set

Eight new tools, registered in `api/mcp.ts` following the exact pattern already used by the six
read-only tools: `server.registerTool(name, { title, description, inputSchema }, async (args) =>
withIdentity(async (accessToken) => { ... }))`, using `createUserScopedClient(accessToken)` for
every query so Postgres RLS (not hand-written filters) enforces per-user isolation.

| Tool | Args | Behavior |
|---|---|---|
| `create_day_template` | `name: string` | Creates a new day template. Returns the new day, including its `id`. |
| `rename_day_template` | `day_id: string, name: string` | Renames an existing day template. |
| `delete_day_template` | `day_id: string` | Hard-deletes the day template. `workout_day_exercises` rows cascade-delete (existing FK); any `sessions` rows that referenced this day keep their history but have `workout_day_id` set to `null` (existing FK: `on delete set null`) — no session or logged-set data is lost. |
| `create_exercise` | `name: string`, optional `cue: string`, `default_sets: number`, `default_rep_low: number`, `default_rep_high: number` | Creates a catalog exercise not yet attached to any day. Omitted optionals fall back to the same defaults as the `exercises` table's own column defaults (`cue: ""`, `default_sets: 3`, `default_rep_low: 10`, `default_rep_high: 12`). To create-and-attach a new exercise to a day in one flow, the caller invokes this tool followed by `add_exercise_to_day` — there is no single combined tool, since two id-scoped calls already cover the case without adding tool-surface. |
| `add_exercise_to_day` | `day_id: string, exercise_id: string` | Appends an existing catalog exercise to the end of the day's exercise list. Errors if the exercise is already on that day (`"Exercise <id> is already on day <id>."`) rather than silently creating a duplicate `workout_day_exercises` row. |
| `remove_exercise_from_day` | `day_id: string, exercise_id: string` | Removes one exercise from the day. Touches only that one `workout_day_exercises` row. |
| `reorder_day_exercises` | `day_id: string, exercise_ids: string[]` | Rewrites the day's exercise order. **Validates that `exercise_ids` is exactly the day's current exercise-id set** (same members, any order) before writing; on mismatch, errors naming the missing/extra ids and pointing the caller at `add_exercise_to_day`/`remove_exercise_from_day` instead of silently changing membership. On success, delegates to the shared `updateDayExercises` function, which preserves each surviving exercise's `target_sets` scheme across the underlying delete-and-reinsert. |
| `set_day_exercise_scheme` | `day_id: string, exercise_id: string, sets: {weight: number, reps: number}[] \| null` | Sets the day-specific rep/weight scheme for one exercise on that day. `null` (or an empty array) clears it, reverting that exercise to its own uniform defaults on that day — matching the existing "use exercise's uniform defaults" convention in `workout_day_exercises.target_sets`. |

Design principles this table encodes, carried over from the earlier discussion:

- **Id-only targeting.** No tool accepts or fuzzy-matches a name for an *existing* row. A
  caller must already have the id (from `get_day_templates`, or from a prior write tool's own
  return value) before calling a write tool. This removes the ambiguous-match failure mode as a
  category, rather than mitigating it with confirmation prompts or best-effort matching.
- **Narrow blast radius per tool.** `add_exercise_to_day`/`remove_exercise_from_day` each touch
  exactly one `workout_day_exercises` row. Only `reorder_day_exercises` performs a full
  delete-and-reinsert of a day's exercise rows, and it's guarded by the set-equality check above
  specifically because that's the one operation broad enough to silently drop data if the
  caller's list is stale or incomplete.
- **No extra confirmation step for delete.** `delete_day_template` takes only `day_id`, matching
  every other write tool — requiring the exact id (already necessary to reach this tool at all)
  is treated as sufficient protection; a name-echo or two-step confirm was considered and
  rejected as unnecessary ceremony on top of the id requirement.

## Where the write logic lives

`src/data/supabase.ts` currently defines its query functions as closures inside
`createSupabaseDataLayer()`, each closing over a single `getSupabase()` browser-session client.
That makes them unusable from `api/mcp.ts`, which needs to supply a different client per
request (`createUserScopedClient(accessToken)`, bearing the resolved caller's token, not the
browser's).

**Refactor**: pull the write functions out to module scope, taking the `SupabaseClient` as an
explicit first parameter:

```ts
export async function createDay(client: SupabaseClient, name: string): Promise<WorkoutDay>
export async function updateDayName(client: SupabaseClient, dayId: string, name: string): Promise<void>
export async function deleteDay(client: SupabaseClient, dayId: string): Promise<void>              // new
export async function updateDayExercises(client: SupabaseClient, dayId: string, exerciseIds: string[]): Promise<void>
export async function addExerciseToDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void>      // new
export async function removeExerciseFromDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void> // new
export async function setDayExerciseTarget(client: SupabaseClient, dayId: string, exerciseId: string, sets: SetEntry[] | null): Promise<void>
export async function createExercise(client: SupabaseClient, input: Omit<Exercise, "id">): Promise<Exercise>
```

`createSupabaseDataLayer()` becomes a thin binder over the same functions:

```ts
export function createSupabaseDataLayer(): DataLayer {
  const supabase = getSupabase();
  return {
    createDay: (name) => createDay(supabase, name),
    deleteDay: (id) => deleteDay(supabase, id),
    // ...etc, one line per DataLayer method
  };
}
```

`DataLayer`'s public interface is unchanged except for the addition of `deleteDay(id: string):
Promise<void>` (a genuine gap today — the app can create/rename days and edit their exercise
list, but has no delete path at all). `src/data/mock.ts` gets a matching in-memory
implementation of `deleteDay`, `addExerciseToDay`, and `removeExerciseFromDay`, keeping both
`DataLayer` backends fully implemented. Every existing app call site (`ManageDays.tsx`, its
tests, etc.) is unaffected — this is a mechanical "inject the client" change, not a logic
change, for every function except the two genuinely new ones (`addExerciseToDay`,
`removeExerciseFromDay`), which are new single-row insert/delete logic against
`workout_day_exercises` (using a `select(...).order("position", { ascending: false }).limit(1)`
query to compute the next append position).

`api/mcp.ts` imports these module-scope functions directly and calls them with
`createUserScopedClient(accessToken)` inside each tool's `withIdentity` body — the same pattern
the six existing read tools already use for their `.rpc()` calls, just calling a plain function
instead of an RPC.

**Dependency note — PR #38 (`exercise-k67.20`, open at the time of writing, not yet merged).**
That PR modifies `setDayExerciseTarget` in both `mock.ts` and `supabase.ts` to also insert a row
into a new `workout_day_exercise_scheme_history` table on every write (for a scheme-edit audit
log), alongside a new `getSchemeHistory` method and a new read-only `scheme_history_for_day_exercise`
MCP tool. It does not touch `updateDayExercises`, `createDay`, or any other function this design
extracts, and introduces no conflict with the "no new migration expected" conclusion below. But
whichever of these two changes lands second must be rebased onto the other: the module-scope
`setDayExerciseTarget(client, dayId, exerciseId, sets)` extracted here must carry forward PR #38's
history-row insert, not just the original update-only logic, once that PR merges.

## Validation & error handling

Every write tool validates against actual DB state before writing, returning a `toolError`
(`` `${toolName} failed: ${message}` ``, matching the existing convention) rather than a silent
no-op, a partial write, or a raw Postgres error:

- **Existence checks.** Any tool taking a `day_id`/`exercise_id` first confirms the row exists
  (RLS on the user-scoped client already guarantees it belongs to the caller if it exists at
  all). A nonexistent or foreign id surfaces as `"Day template <id> not found."` /
  `"Exercise <id> not found."`.
- **`reorder_day_exercises` set-equality check** (Tool set, above): mismatch names the missing
  and extra ids explicitly and points at the narrower tools instead.
- **`add_exercise_to_day` duplicate check**: rejects attaching an exercise already on the day.
- **`user_id` is never an accepted tool parameter** on any write. It is always left to the
  column's `default auth.uid()` (inserts) or implied by the RLS-checked row (updates/deletes) —
  never taken from caller input, per the RLS-coverage conclusion below.
- **Numeric bounds on `create_exercise`/`set_day_exercise_scheme`** mirror the app's existing
  `SchemeEditor` validation in `ManageDays.tsx`: weight 0–500, reps 1–40 (integer) — rejected
  with a clear message rather than passed through, since there are no DB-level check
  constraints on these columns today.
- **Successful writes return the affected row(s)** via `toolResult(...)` (e.g.
  `create_day_template` returns the new day with its `id`), so a caller can confirm the result
  without an immediate follow-up read.

## RLS coverage (no new migration expected)

Read from `supabase/migrations/0001_init.sql`, `0003_harden_child_rls.sql`, and
`0002_grants.sql`. Every table this design writes to already has caller-scoped policies:

| Table | Insert | Update | Delete |
|---|---|---|---|
| `exercises` | ✅ own_insert | ✅ own_update | ✅ own_delete |
| `workout_days` | ✅ own_insert | ✅ own_update | ✅ own_delete |
| `workout_day_exercises` | ✅ hardened (`0003`) — day + exercise must both be caller's | ✅ hardened | ✅ own_delete |

("Hardened" policies additionally verify parent-row ownership via `exists(...)`, not just
`user_id = auth.uid()` stamping — added in `0003_harden_child_rls.sql` specifically to stop a
caller from attaching a row to another user's day/exercise even if they somehow knew its UUID.)

Since every write path here goes through `.from(table).insert/update/delete()` via the same
user-scoped client the read tools already use (never a new `security definer` RPC), **no new
migration is expected**. This conclusion comes from reading the migration files, not from
running anything against a live database — it should be spot-checked against a real Supabase
instance before merging.

## Testing plan

`api/mcp.test.ts` already has the right shape for MCP-level testing: a fake in-memory Supabase
client (`makeSupabaseClient`) keyed by which user's access token was presented, driven through a
real MCP SDK client/transport over a real HTTP server. `src/data/supabase.ts` itself has no
existing unit tests (it's a thin live-Supabase wrapper); `src/data/mock.ts` does, via
`src/data/mock.test.ts`.

- **Shared write functions**: unit-test the refactored/new functions — `createDay`, `deleteDay`,
  `addExerciseToDay`, `removeExerciseFromDay`, and especially `updateDayExercises`'s
  `target_sets`-preservation behavior — against a lightweight fake client.
- **`mock.ts`**: add `deleteDay`, `addExerciseToDay`, `removeExerciseFromDay` with matching cases
  in `src/data/mock.test.ts`.
- **MCP integration tests** (extend `api/mcp.test.ts`): grow the fake client's `.from()` fixture
  into fake tables (`workout_days`, `workout_day_exercises`, `exercises`) supporting
  insert/update/delete, mirroring how the existing RPC fixtures are keyed per user. Cover:
  - Each of the 8 tools succeeding and returning the right row(s) on a legitimate call.
  - Cross-user isolation — user A's token cannot write to user B's day/exercise ids.
  - `reorder_day_exercises`'s set-mismatch rejection and `add_exercise_to_day`'s duplicate
    rejection.
  - `target_sets` surviving a `reorder_day_exercises` round-trip — the regression case this
    design's reuse-not-duplicate approach exists to prevent.
- No migration tests are planned, per the "no new migration expected" conclusion above — but see
  that section's caveat about confirming against a real instance.

## Out of scope

- **Logging a workout session** (creating a `sessions` row + `session_sets`) — the other half of
  the parent epic `exercise-w2w`. Deliberately excluded from this spec at the user's direction;
  a future bead should cover it, and should specifically mirror the existing app's
  resume-or-create pattern (`Home.tsx`'s `start()`: look up
  `getSessionForDayAndDate(dayId, date)` before creating) to avoid recreating the exact junk-row
  bug `exercise-db9` fixed.
- **Fuzzy or best-effort name matching** for existing rows — rejected in favor of id-only
  targeting (see Tool set, above).
- **A combined "create and attach" exercise tool** — two id-scoped calls
  (`create_exercise` → `add_exercise_to_day`) already cover this without adding tool-surface.
- **Delete confirmation/name-echo step** for `delete_day_template` — considered and rejected as
  unnecessary given the id requirement already in place.
- **New Postgres RPC functions** for these writes — considered (Approach C) and rejected in
  favor of reusing `src/data/supabase.ts`'s existing tested query logic via a client-injection
  refactor, since introducing SQL versions of the same multi-step logic (e.g. `target_sets`
  preservation) would be a second reimplementation, not a reduction of duplication.
