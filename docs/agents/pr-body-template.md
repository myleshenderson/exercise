# PR body template

Every PR in this repository, whether an agent, the dispatch runner or a person opened it,
uses this body. The agent that touches a PR rewrites its body to this shape before
reporting, and the lead checks the body before adding `auto-merge`. Myles reads the
body, not the diff, to decide whether to merge; a three-line "Automated fix for AI-nnn"
is not a body. Markdown headings as below, in this order, the issue id in the title.

```markdown
## Why

## What changed

## How it was validated

## Review

## For the merger

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Why**: the problem or request in the Linear issue's own terms, with the issue id and
who it affects, so a reader knows what would be true if this PR were not merged.

**What changed**: each behaviour change and each file group touched, including anything
deliberately left out of scope and the issue that holds it.

**How it was validated**: the exact commands run and their results (test counts, local
runs, live begin/rollback suites, screenshots), and what was not run and why.

**Review**: which review passes ran (`/code-review` rounds), what they found, and what
was fixed or consciously declined, so the merger does not repeat the review.

**For the merger**: what happens on merge (deploy, migration applied, label to add,
issue to close, follow-up to label) and anything the merger must check or decide first.

**Attribution line**: the `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
line last, as CLAUDE.md requires for PR descriptions; commits carry their own
`Co-Authored-By` trailer.
