# Lead project profile: <project>

Copy this file to `docs/agents/lead-project.md` and fill in every section; write "none"
rather than deleting one. The `lead` skill reads it right after `SKILL.md`, and it wins
where the two disagree. Keep facts terse and dated; correct them in place when they
change, in the same PR as the session-end docs.

## Tracker

Which tracker, workspace, team and project. The ready state. The exact listing commands
for in-review and in-progress issues. How blocks relations work and what the runner does
with them. Which projects or queues are off-limits to agents.

## Automation and merge path

The dispatch label and what claims it. The merge label, what merges on it and under which
conditions (CI green on the exact head? a worktree the monitor knows?). Whether a PR the
lead or a lead subagent opens merges automatically or needs Myles. The CI workflow name
to filter on for the pre-merge check, and other workflows whose failures are not CI
failures. How to read job logs from the container. Known runner and monitor quirks.

## WIP cap and streams

How many open agent PRs, what each slot may hold, and the history that set the number.

## Validation commands for briefs

Formatter, analyzer, touched-test runner, screenshot command, memory-note convention.
Every brief names these.

## Environment limits

Credentials and tools the agent container lacks, and which checks the lead must run on
the branch instead. Disk and build-output directories to clean. Worktree restrictions.

## Migrations and production

What counts as a schema or data change, how it is rehearsed, who merges it.

## Boundary examples for this project

Concrete user-felt policy changes Myles approves; the grey area the lead decides and
flags; any standing rule (freeze weeks, release windows).

## Start-of-session readings

Metrics or health scripts to run at session start, and what they need.

## Review depth examples

PRs that set the precedent for read-and-run, medium and high review.

## Where project things live

Table of project-specific files and external places the skill's generic table does not
cover.
