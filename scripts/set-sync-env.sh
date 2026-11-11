#!/usr/bin/env bash
# Sets the env vars PR #92 (AI-641, ride sync) needs, in .env.local and in Vercel Production.
# Run from the exercise repo root on your machine, after `vercel login` and `vercel link`.
# Secrets are read from prompts or an existing .env.local, never passed on argv.
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.local}"
touch "$ENV_FILE"

get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }   # current value in .env.local
put() {                                                                  # upsert NAME=value in .env.local
  local tmp; tmp="$(mktemp)"
  grep -vE "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}
ask() {   # ask NAME "prompt" [secret]; keeps the existing .env.local value when you press Enter
  local cur; cur="$(get "$1")"
  if [ -n "$cur" ]; then printf '%s already set in %s. Enter to keep, or type a new value: ' "$1" "$ENV_FILE"
  else printf '%s (%s): ' "$1" "$2"; fi
  local v
  if [ "${3:-}" = secret ]; then read -rs v; echo; else read -r v; fi
  [ -n "$v" ] || v="$cur"
  [ -n "$v" ] || { echo "$1 is required" >&2; exit 1; }
  put "$1" "$v"
}

# Generated once and reused on later runs. CREDENTIALS_KEY must be the SAME value in
# .env.local and Vercel or the cron cannot decrypt what the CLI stored.
[ -n "$(get CREDENTIALS_KEY)" ] || put CREDENTIALS_KEY "$(openssl rand -base64 32)"
[ -n "$(get CRON_SECRET)" ]     || put CRON_SECRET "$(openssl rand -hex 32)"

ask SUPABASE_URL              "https://<project>.supabase.co"
ask SUPABASE_SERVICE_ROLE_KEY "service-role key from Supabase > Settings > API" secret
ask SYNC_OWNER_USER_ID        "your auth.users id (Supabase > Authentication > Users)"
ask GARMIN_API_KEY            "the ROTATED Garmin Personal API key" secret
ask PELOTON_AUTH0_CLIENT_ID   "the azp claim of a Peloton access token"
ask PELOTON_REFRESH_TOKEN     "Auth0 refresh token, bootstrap only" secret
[ -n "$(get SYNC_DEFAULT_TIMEZONE)" ] || put SYNC_DEFAULT_TIMEZONE "America/New_York"

echo
echo "Pushing to Vercel (Production). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already there and are skipped;"
echo "set VERCEL_SET_SUPABASE=1 to push them too."
vset() {   # vset NAME [--sensitive]; value piped on stdin, --force overwrites an existing var
  local v; v="$(get "$1")"
  printf '%s' "$v" | vercel env add "$1" production --force ${2:-} >/dev/null
  echo "  set $1"
}
vset SYNC_OWNER_USER_ID
vset GARMIN_API_KEY          --sensitive
vset PELOTON_AUTH0_CLIENT_ID
vset CREDENTIALS_KEY         --sensitive
vset CRON_SECRET             --sensitive
vset PELOTON_REFRESH_TOKEN   --sensitive
vset SYNC_DEFAULT_TIMEZONE
if [ "${VERCEL_SET_SUPABASE:-0}" = 1 ]; then
  vset SUPABASE_URL
  vset SUPABASE_SERVICE_ROLE_KEY --sensitive
fi

echo
echo "Done. $ENV_FILE holds the same values for 'npm run sync'. Vercel picks the new vars up on the next deploy,"
echo "which merging PR #92 triggers. Verify with: vercel env ls production"
