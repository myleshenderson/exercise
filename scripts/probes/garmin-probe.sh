#!/usr/bin/env bash
# Garmin Connect Personal API probe. Usage: export GARMIN_API_KEY=...; bash garmin-probe.sh
# Endpoints from garmin/connect-personal-api-python (client.py, constants.py).
# The key and bearer token travel to curl on stdin (-H @-), so they never appear in argv/ps.
set -u
BASE="${GARMIN_PERSONAL_API_BASE_URL:-https://personal.connectapi.garmin.com}"
OUT="./garmin-probe-out"
umask 077
mkdir -p "$OUT"
for t in curl jq python3; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done
if [ -z "${GARMIN_API_KEY:-}" ]; then echo "Set GARMIN_API_KEY first (export GARMIN_API_KEY=...)"; exit 1; fi

day() { python3 -I -c 'import sys,datetime;print(datetime.date.today()-datetime.timedelta(days=int(sys.argv[1])))' "$1"; }
TODAY=$(day 0); D6=$(day 6); D29=$(day 29)

summary() { # name code file
  local bytes=0; [ -f "$3" ] && bytes=$(wc -c <"$3" | tr -d ' ')
  printf '%-26s HTTP %s  %s bytes  -> %s\n' "$1" "$2" "$bytes" "$3"
}

# --- 1. token exchange (POST, Authorization: ApiKey <key>, body = bare JWT text)
TOKFILE="$OUT/.token.raw"   # holds the bearer token; deleted at the end, never printed
code=$(printf 'Authorization: ApiKey %s\n' "$GARMIN_API_KEY" | curl -sS -X POST -H @- -H 'Accept: */*' \
  -o "$TOKFILE" -w '%{http_code}' "$BASE/personalapitoken-service/personal-api/personal-api-key/token")
TOKEN=""
if [ "$code" = "200" ]; then
  TOKEN=$(tr -d '\r\n"' <"$TOKFILE")
  # Save only the decoded JWT claims, not the token itself.
  printf '%s' "$TOKEN" | python3 -I -c '
import sys,json,base64,datetime
t=sys.stdin.read().strip()
try:
    p=t.split(".")[1]; c=json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))
except Exception as e:
    print("token is not a JWT:",type(e).__name__); sys.exit(0)
json.dump(c,open(sys.argv[1],"w"),indent=2)
exp=c.get("exp"); now=datetime.datetime.now(datetime.timezone.utc).timestamp()
print("token exp:",datetime.datetime.fromtimestamp(exp,datetime.timezone.utc).isoformat() if exp else "none",
      "(%.1f h from now)"%((exp-now)/3600) if exp else "", "claims:",",".join(sorted(c)))
' "$OUT/token-claims.json"
  summary token "$code" "$OUT/token-claims.json"
else
  cp "$TOKFILE" "$OUT/token-error.json"; summary token "$code" "$OUT/token-error.json"
  echo "  token exchange failed; continuing so you can see each endpoint's status"
fi
rm -f "$TOKFILE"

get() { # name path [accept]
  local name=$1 path=$2 accept=${3:-application/json} file="$OUT/$1.json" code
  [ "$accept" != "application/json" ] && file="$OUT/$1"
  code=$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS -H @- -H "Accept: $accept" \
    -o "$file" -w '%{http_code}' "$BASE$path") || code="curl-error"
  summary "$name" "$code" "$file"
  sleep 1   # no documented rate limit; be polite
}

# --- 2. profile
get profile-settings "/userprofile-service/userprofile/settings"

# --- 3. 20 most recent activities, then detail + workouts + original file of the newest
get activities "/activitylist-service/activities/search/activities?start=0&limit=20"
AID=$(jq -r '(if type=="array" then . else (.activityList // .activities // []) end) | .[0].activityId // empty' \
  "$OUT/activities.json" 2>/dev/null)
if [ -n "$AID" ]; then
  echo "  newest activity: $AID ($(jq -r '(if type=="array" then . else (.activityList // .activities) end)[0] | "\(.activityType.typeKey // "?") \(.startTimeLocal // "?")"' "$OUT/activities.json"))"
  get activity-detail "/activity-service/activity/$AID"
  get activity-workouts "/activity-service/activity/$AID/workouts"
  get "activity-$AID.zip" "/download-service/files/activity/$AID" \
    "application/zip, application/x-zip-compressed, application/octet-stream"
  python3 -I -c '
import sys,zipfile
f=sys.argv[1]
if zipfile.is_zipfile(f):
    z=zipfile.ZipFile(f); print("  zip entries:",[(i.filename,i.file_size) for i in z.infolist()])
    for i in z.infolist():
        if i.filename.lower().endswith(".fit"): open(sys.argv[2],"wb").write(z.read(i)); print("  extracted ->",sys.argv[2])
else:
    print("  download is not a zip (first bytes: %r)"%open(f,"rb").read(16))
' "$OUT/activity-$AID.zip" "$OUT/activity-$AID.fit"
else
  echo "  no activityId found in activities.json; skipping detail/download"
fi

# --- 4. weight / body composition, last 30 days
get weight-30d "/weight-service/weight/range/$D29/$TODAY?includeAll=true"

# --- 5. daily summaries, last 7 days
get dailysummaries-7d "/usersummary-service/v2/dailysummaries?startDate=$D6&endDate=$TODAY"

# --- 6. sleep, last 7 days (range summary + per-night detail)
get sleep-summaries-7d "/sleep-service/sleep/dailySleepSummariesByDate?startDate=$D6&endDate=$TODAY"
for i in 0 1 2 3 4 5 6; do d=$(day $i); get "sleep-$d" "/sleep-service/sleep/dailySleep?date=$d"; done

# --- 7. OpenAPI spec: committed in the repo as docs/reference/garmin-personal-api-openapi.json
#        (26 GET endpoints, 109 schemas; PR #80). Garmin's swagger-docs page inlines the spec in its
#        Gatsby bundle, so DevTools shows no spec request; see docs/agents/project-memory.md to refresh it.
echo "OpenAPI spec: see docs/reference/garmin-personal-api-openapi.json (nothing to capture here)."
echo "Share $OUT (token-claims.json contains no token)."
