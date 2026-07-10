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
CONN="postgresql://postgres@db.aeolejvpsavbbmluysnm.supabase.co:5432/postgres?options=-c%20default_transaction_read_only%3Don"

if [[ $# -ge 1 ]]; then
  exec env PGPASSWORD="$SUPABASE_PASSWORD" PGCONNECT_TIMEOUT=10 \
    psql "$CONN" --set=ON_ERROR_STOP=1 -P pager=off -c "$1"
else
  exec env PGPASSWORD="$SUPABASE_PASSWORD" PGCONNECT_TIMEOUT=10 \
    psql "$CONN" --set=ON_ERROR_STOP=1 -P pager=off -f -
fi
