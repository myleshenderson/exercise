#!/usr/bin/env bash
# Read-only query runner for the exercise app's Supabase database.
# Usage: query.sh "SELECT ..."   or   echo "SELECT ..." | query.sh
#
# LOCAL DEV / DEBUG ONLY — NOT for conversational workout analysis.
# This connects as the `postgres` superuser, which BYPASSES row-level
# security: every query here returns every user's rows, unscoped and
# undifferentiated. It was fine when Myles's account was the only row in
# every table; a second real user's data now exists, so this must not be
# used to answer a user's workout questions. Use the app's per-user-scoped
# MCP tools (api/mcp.ts) for that instead.
#
# Requires explicit opt-in via ALLOW_SUPERUSER_QUERY=1 so it can't be
# invoked by mistake now that the MCP route is live.
set -euo pipefail

if [[ "${ALLOW_SUPERUSER_QUERY:-}" != "1" ]]; then
  echo "error: query.sh is a local dev/debug tool that bypasses row-level security (superuser access to ALL users' data)." >&2
  echo "       It must not be used for conversational workout analysis — use the MCP tools in api/mcp.ts instead." >&2
  echo "       If you are Myles, deliberately debugging schema/data locally, re-run with ALLOW_SUPERUSER_QUERY=1." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — it must contain SUPABASE_PASSWORD and SUPABASE_DB_HOST (gitignored, so absent on fresh clones)" >&2
  exit 1
fi

SUPABASE_PASSWORD="$(grep -E '^SUPABASE_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
if [[ -z "$SUPABASE_PASSWORD" ]]; then
  echo "error: SUPABASE_PASSWORD not set in $ENV_FILE" >&2
  exit 1
fi

SUPABASE_DB_HOST="$(grep -E '^SUPABASE_DB_HOST=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
if [[ -z "$SUPABASE_DB_HOST" ]]; then
  echo "error: SUPABASE_DB_HOST not set in $ENV_FILE (full hostname, e.g. db.<project-ref>.supabase.co)" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql not found on PATH (brew install libpq or postgresql)" >&2
  exit 1
fi

# options=-c default_transaction_read_only=on (URI-encoded) makes the whole
# session read-only; any INSERT/UPDATE/DELETE/DDL errors out server-side.
CONN="postgresql://postgres@${SUPABASE_DB_HOST}:5432/postgres?options=-c%20default_transaction_read_only%3Don"

export PGPASSWORD="$SUPABASE_PASSWORD"
export PGCONNECT_TIMEOUT=10

if [[ $# -ge 1 ]]; then
  exec psql "$CONN" --set=ON_ERROR_STOP=1 -P pager=off -c "$1"
else
  exec psql "$CONN" --set=ON_ERROR_STOP=1 -P pager=off -f -
fi
