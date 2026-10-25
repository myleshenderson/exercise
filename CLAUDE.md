# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Linear Issue Tracker

Issues live in Linear: workspace **CommsCenter**, team **AI Batteries
Included** (key `AI`), project **exercise**
(https://linear.app/comms-center/project/exercise-a6ac7e06809d).
Issue identifiers look like `AI-383`.

Beads (`bd`) was retired on 2026-10-25. Every bead that was open on that
day was imported as a Linear issue whose description ends with
`Imported from beads <bead-id>`, so an old `exercise-xxx` id found in a
doc, comment or commit resolves with:

```bash
linear issue query --project exercise --search "Imported from beads exercise-xxx" --no-input
```

Closed beads were not imported. Their history (and the `bd remember`
store, now exported to `docs/agents/project-memory.md`) is in the archived
`.beads/` directory on Myles's machine at `~/wtree-cutover/exercise.beads/`.

### Using the `linear` CLI

The `linear` CLI (schpet/linear-cli, pinned at 3.1.0 in the agent image)
is on PATH in agent containers and authenticates with the `LINEAR_API_KEY`
environment variable, which the container already has. `.linear.toml` in
the repo root sets the default workspace and team, so `--team AI` can be
omitted; `--project exercise` cannot, because the CLI has no default
project. Three habits that avoid a wasted turn:

- Always pass `--no-input`: a missing value then fails instead of
  prompting, which would hang a non-interactive session.
- Pass `--json` when parsing output (`issue view --json --no-comments
  --no-download` for a single issue).
- `issue create` lands in **Backlog** unless you pass `--state Todo`.
  Only Todo issues count as ready work.

```bash
linear auth whoami --no-input                                   # expect workspace CommsCenter, user myles1
linear issue query --project exercise --state Todo --no-input              # ready work (add --limit all for everything)
linear issue query --project exercise --search "<text>" --no-input         # full-text search; --search-comments to include comments
linear issue view AI-383 --no-input                             # title, description, parent, children, attachments, comments
linear issue create --project exercise --state Todo --priority medium \
  --title "..." --description-file /path/to/body.md --no-input   # --label needs-input, --parent AI-383 as needed
linear issue update AI-383 --state "In Progress" --assignee @me --no-input
linear issue update AI-383 --state Done --no-input              # states: Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate
linear issue update AI-383 --add-label auto-merge --no-input    # --remove-label to take one off
linear issue comment add AI-383 --body "..." --no-input         # or --body-file; use for progress notes and hand-offs
linear issue relation add AI-387 blocks AI-385 --no-input       # relations: blocks, blocked-by, related, duplicate
linear issue link AI-383 https://github.com/myleshenderson/exercise/pull/33 --no-input
linear api --no-input 'query{ issue(id:"AI-383"){ state{name} children{nodes{identifier}} } }'   # raw GraphQL when the CLI has no flag
```

Priority is by name or number: `urgent` (1), `high` (2), `medium` (3),
`low` (4), `none` (0). Multi-line descriptions and comments go in a file
and through `--description-file` / `--body-file`; Linear renders Markdown.

### Labels the automation reads

These are workspace labels; the worktree-tools daemons act on them.

- `auto-execute`: the dispatch runner claims a **Todo** issue carrying
  this label, runs an agent on it, and opens a PR. It moves the issue to
  In Progress and attaches the PR itself.
- `auto-merge`: the PR monitor merges that PR once CI is green, then
  moves the issue to Done. Without it a human merges.
- `needs-input`: blocked on a decision from Myles. Leave the issue in
  Todo or Backlog with the open questions in a comment.

### Rules

- Use Linear for ALL task tracking: do not use TodoWrite, TaskCreate, or
  markdown TODO lists.
- File a Linear issue for any follow-up work you discover and cannot
  finish in the current task. Put must-dos in the description, not in a
  comment; comments are for progress and hand-offs.
- Name the issue in the commit subject, `AI-383: <what changed>`, the way
  commits used to start with the bead id.
- Keep durable, non-obvious knowledge in `docs/agents/project-memory.md`
  (the successor to `bd remember`); do not create ad hoc memory files.

### Session completion

Subordinate to explicit user, repository, and orchestrator instructions.

1. File Linear issues for remaining work.
2. Run quality gates if code changed: `npm run typecheck`, `npm test`,
   and `npm run build` when the change touches the Vite app.
3. Update issue state and leave a hand-off comment on the issue.
4. Commit on a branch, push it, and open a PR. Never push to `main` and
   never merge the PR yourself.
5. Hand off: summarize changes, validation, issue status, and anything
   blocked.


## Build & Test

```bash
npm install
npm run typecheck   # tsc --noEmit for the app and tsconfig.api.json for api/
npm test            # vitest run
npm run build       # tsc -b && vite build
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_

- Supabase migrations: see [docs/supabase-migrations.md](docs/supabase-migrations.md)
  for whether they currently auto-apply to production and how.
