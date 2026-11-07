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
