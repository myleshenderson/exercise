# Decision log

Decisions Claude made as project lead under the delegation Myles gave (boundary in
`.claude/skills/lead/SKILL.md`, project specifics in `docs/agents/lead-project.md`).
Anything on the "Myles approves" side of that boundary is never here; it goes to Myles as
a question and his answer is recorded in `docs/agents/handoff.md`.

Append-only, one row per decision, newest last. Columns: **When (UTC)** the decision was
made; **Decision** what was done; **Why** the reasoning in one line; **Undo** the command
or step that reverses it, or `n/a`. Never rewrite or delete a row; append a new row that
supersedes it. Rows before this file existed were recorded as comments on the Linear
issues and in the epic AI-386 description; the log starts with the session that created it.

| When (UTC) | Decision | Why | Undo |
|---|---|---|---|
| 2026-11-07 13:50 | Accepted PR #62 (AI-606) with its edit to `starkeep/dataProxy.test.ts` adding a JSON content-type header | The untyped POST in that test is exactly what the new 415 gate refuses; assertions unchanged, deviation disclosed in the PR body | n/a (merged) |
| 2026-11-07 13:50 | Accepted PR #63 (AI-608) behaviour change: `listTokenRows` throws on a truncated page without `page_token` | Fail-closed beats a silently partial token list; callers only catch | n/a (merged) |
| 2026-11-07 13:50 | Posted an independent verification brief on PR #64 (AI-610) and left it without `auto-merge` | It touches `api/mcp.ts`, the production Vercel path; Myles reviews those | n/a |
| 2026-11-07 13:50 | Parented AI-611 (no-Origin cross-site GET gate) to AI-386 as Backlog | Filed by the AI-606 agent; real but not blocking the epic | `linear issue update AI-611 --parent "" --no-input` |
| 2026-11-07 13:50 | Noted on AI-597 that the starkeep-apps PR must decide whether to strip the Vercel/Supabase files and must pass that repo's CI | The copy into `starkeep-apps` publishes the whole folder; Myles's repo is private | delete the comment |
| 2026-11-07 19:16 | Closed gate AI-594 and set AI-610 Done after Myles merged #64 (d4da1e9) | Main run 42405246485 `test` green; `migrate` red is the pre-existing AI-602 | `linear issue update AI-594 --state Todo --no-input` |
| 2026-11-07 21:43 | Created AI-620 and opened a lead PR adding the portable `lead` skill, the exercise profile and the state docs | Myles: "i want a lead skill for this repo"; docs only, the "immediately" exception to dispatch | close the PR, cancel AI-620 |
| 2026-11-07 23:52 | Merged PR #65 (AI-607) on Myles's explicit instruction ("merge it") after the verification subagent passed every AC | Owner-directed merge; the only AC gap (live Generate-token check) is covered by AI-595 | n/a (merged) |
| 2026-11-08 00:01 | Pinned decisions into AI-613/614/615 as "Lead intake notes" and promoted them to Todo with `auto-execute` (`auto-merge` on 613 and 614; 615 draft for the owner) | Intake digest found either/or seams, stale line numbers, an in-use-exercise test that contradicts `DataLayer.ts`, an unowned `package-lock.json` and a fixture fix that cannot stub a child process | `linear issue update AI-61n --state Backlog --label "" --no-input`; the original descriptions are in the Linear history |
| 2026-11-08 00:01 | AI-614: the test seam is `vi.mock("./supabaseClient")`; `src/data/supabase.ts` is not modified | Epic decision "additive, no `src/**` logic change"; the production DataLayer stays byte-identical | n/a (merged in #68) |
| 2026-11-08 00:01 | AI-614: dropped the "delete of an in-use exercise is rejected" test; assert pass-through | `DataLayer.ts:13-16` says the Supabase layer does not reject; the guard is in `api/mcp.ts` | n/a |
| 2026-11-08 00:01 | AI-615: `package-lock.json` added to Owns; `@vitest/coverage-v8` pinned to 4.1.9; ref guard first in the migrate job; fixture fix is `stdio: "pipe"` | Installing the provider changes the lockfile; exact pin matches vitest; a missing ref is a configuration error; the checker runs as a child process | n/a |
| 2026-11-08 00:01 | Removed AI-617's blocked-by relations to AI-607 (merged), AI-613 and AI-614; kept AI-615 | Its only real dependency is the `test:coverage` script AI-615 adds; files are disjoint from 613/614 | `linear issue relation add AI-613 blocks AI-617 --no-input` (and 614) |
| 2026-11-08 00:33 | Dispatched a post-merge verification subagent for #67 and #68 instead of a pre-merge read | Both auto-merged on green CI before the lead saw them; the profile's flow for non-production paths | n/a |
| 2026-11-08 00:35 | Posted a review brief on #69 recommending merge, left it a draft without `auto-merge` | It edits CI and the migrate job; Myles reviews those | n/a |
| 2026-11-08 00:40 | Left the July plan's stale "hardcoded in query.sh" sentence alone; AI-616's README will say `docs/superpowers/` is history | Epic decision: design history is untouched | n/a |
| 2026-11-08 03:40 | Opened the lead docs PR mid-session while #69 waits on Myles | Subagents and worktrees die with the container; the handoff and log must survive | close the PR |
