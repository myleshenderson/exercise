#!/usr/bin/env bash
# Peloton API probe, based on the unofficial pelo-tech/peloton-api-spec (v0.3.0, 2021).
# Usage: PELOTON_USERNAME=... PELOTON_PASSWORD=... ./peloton-probe.sh
# Needs curl, jq, python3. Writes to ./peloton-probe-out/ (mode 700, files 600).
# Set PROBE_CSV=1 to also try the CSV export (NOT IN SPEC; path from memory).
set -u
umask 077

BASE="https://api.onepeloton.com"            # spec servers[0]
OUT="./peloton-probe-out"
JAR="$OUT/cookies.txt"
# Spec info.description: some newer endpoints need peloton-platform: web
HDRS=(-H "peloton-platform: web" -H "Content-Type: application/json" -H "Accept: application/json")

: "${PELOTON_USERNAME:?set PELOTON_USERNAME}"
: "${PELOTON_PASSWORD:?set PELOTON_PASSWORD}"
for t in curl jq python3; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done

mkdir -p "$OUT" && chmod 700 "$OUT"
: > "$JAR" && chmod 600 "$JAR"

# step NAME FILE CURL_ARGS... -> prints "NAME: HTTP <code>, <bytes> bytes, <file>"
step() {
  local name="$1" file="$2"; shift 2
  local code
  code=$(curl -sS -o "$file" -w '%{http_code}' -b "$JAR" -c "$JAR" "${HDRS[@]}" "$@" 2>"$OUT/.curl_err") || code="curl-error($(tr -d '\n' < "$OUT/.curl_err"))"
  [ -f "$file" ] && chmod 600 "$file"
  printf '%-22s HTTP %s, %s bytes, %s\n' "$name:" "$code" "$( [ -f "$file" ] && wc -c < "$file" | tr -d ' ' || echo 0)" "$file"
}

# 1. Login: POST /auth/login {username_or_email, password}. Body built from env
#    by python (never on argv, never echoed), in a 600 temp file deleted on exit.
BODY=$(mktemp "$OUT/.login.XXXXXX"); chmod 600 "$BODY"
trap 'rm -f "$BODY" "$OUT/.curl_err"' EXIT
python3 -I -c 'import json,os,sys; json.dump({"username_or_email":os.environ["PELOTON_USERNAME"],"password":os.environ["PELOTON_PASSWORD"]}, sys.stdout)' > "$BODY"
step "login" "$OUT/login.json" -X POST --data-binary "@$BODY" "$BASE/auth/login"
rm -f "$BODY"
USER_ID=$(jq -r '.user_id // empty' "$OUT/login.json" 2>/dev/null)
# Redact the session id from the saved login response (it is also in the cookie jar).
jq '.session_id |= (if . then "REDACTED" else . end)' "$OUT/login.json" > "$OUT/login.tmp" 2>/dev/null \
  && mv "$OUT/login.tmp" "$OUT/login.json"
grep -q peloton_session_id "$JAR" && echo "  cookie peloton_session_id: set" || echo "  cookie peloton_session_id: NOT set"
[ -n "$USER_ID" ] || echo "  no user_id in login response; will try /api/me"

# 2. /api/me
step "me" "$OUT/me.json" "$BASE/api/me"
jq -r '"  id=\(.id // "?") total_workouts=\(.total_workouts // "?")"' "$OUT/me.json" 2>/dev/null
[ -n "$USER_ID" ] || USER_ID=$(jq -r '.id // empty' "$OUT/me.json" 2>/dev/null)
[ -n "$USER_ID" ] || { echo "no user id; stopping"; exit 1; }

# 3. 20 most recent workouts. Spec example joins is "peloton.ride"; also try ride,ride.instructor.
step "workouts(ride)" "$OUT/workouts_ride.json" -G "$BASE/api/user/$USER_ID/workouts" \
  --data-urlencode "joins=ride,ride.instructor" -d limit=20 -d page=0 -d sort_by=-created
step "workouts(peloton)" "$OUT/workouts_peloton.json" -G "$BASE/api/user/$USER_ID/workouts" \
  --data-urlencode "joins=peloton.ride,peloton.ride.instructor" -d limit=20 -d page=0 -d sort_by=-created
jq -r '"  total=\(.total // "?") count=\(.count // "?") disciplines=\([.data[]?.fitness_discipline]|unique|join(","))"' \
  "$OUT/workouts_ride.json" 2>/dev/null
WID=$(jq -r '.data[0].id // empty' "$OUT/workouts_ride.json" 2>/dev/null)
[ -n "$WID" ] || WID=$(jq -r '.data[0].id // empty' "$OUT/workouts_peloton.json" 2>/dev/null)
[ -n "$WID" ] || { echo "no workouts found; stopping"; exit 1; }
echo "  newest workout id=$WID"

# 4. Newest workout detail (spec example joins) and performance graph every_n=60
step "workout" "$OUT/workout_$WID.json" -G "$BASE/api/workout/$WID" \
  --data-urlencode "joins=peloton,peloton.ride,peloton.ride.instructor,user"
step "performance_graph" "$OUT/perf_$WID.json" -G "$BASE/api/workout/$WID/performance_graph" -d every_n=60

# 5. Ride details: GET /api/ride/{rideId}/details
RID=$(jq -r '.ride.id // .peloton.ride.id // empty' "$OUT/workout_$WID.json" 2>/dev/null)
if [ -n "$RID" ]; then
  step "ride_details" "$OUT/ride_$RID.json" "$BASE/api/ride/$RID/details"
  jq -r '"  top-level keys: \(keys|join(","))"' "$OUT/ride_$RID.json" 2>/dev/null
else
  echo "ride_details:          skipped (no ride id in workout detail; e.g. just-ride/free mode)"
fi

# 6. Overview (workout counts by discipline)
step "overview" "$OUT/overview.json" "$BASE/api/user/$USER_ID/overview"

# 7. CSV export: NOT IN SPEC. Opt-in only.
if [ "${PROBE_CSV:-0}" = "1" ]; then
  step "workout_history_csv" "$OUT/workout_history.csv" \
    "$BASE/api/user/$USER_ID/workout_history_csv?timezone=UTC"
fi
echo "done; outputs in $OUT (contain personal data; delete when finished)"
