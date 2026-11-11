#!/usr/bin/env bash
# Peloton API probe. Data endpoints from the unofficial pelo-tech/peloton-api-spec (v0.3.0, 2021);
# authentication is a bearer token copied from a signed-in browser session, because Peloton
# retired POST /auth/login in late 2025 (it now answers 403 "Endpoint no longer accepting
# requests" for any credentials) and signs in through Auth0 instead.
#
# Usage: export PELOTON_BEARER_TOKEN=...; bash peloton-probe.sh
#   PELOTON_USER_ID=...  skip the /api/me lookup (optional)
#   PROBE_CSV=1          also try the CSV export (NOT IN SPEC; path from memory)
#
# How to get the token: sign in at https://members.onepeloton.com, open DevTools > Network,
# click any request to api.onepeloton.com/api/..., and copy the value of the Authorization
# request header without the leading "Bearer ". Tokens last about 48 hours.
#
# Needs curl, jq, python3. Writes to ./peloton-probe-out/ (mode 700, files 600). The token
# travels to curl on stdin (-H @-), so it never appears in argv/ps or in any output file.
set -u
umask 077

BASE="${PELOTON_API_BASE_URL:-https://api.onepeloton.com}"   # spec servers[0]
OUT="./peloton-probe-out"
# Spec info.description: some newer endpoints need peloton-platform: web
HDRS=(-H "peloton-platform: web" -H "Accept: application/json")

: "${PELOTON_BEARER_TOKEN:?set PELOTON_BEARER_TOKEN (see header comment for where to copy it from)}"
TOKEN="${PELOTON_BEARER_TOKEN#Bearer }"   # tolerate a copy that kept the scheme
for t in curl jq python3; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done

mkdir -p "$OUT" && chmod 700 "$OUT"
trap 'rm -f "$OUT/.curl_err"' EXIT

# Save only the decoded JWT claims (issuer, audience, scope, expiry), never the token.
printf '%s' "$TOKEN" | python3 -I -c '
import sys,json,base64,datetime
t=sys.stdin.read().strip()
try:
    p=t.split(".")[1]; c=json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))
except Exception as e:
    print("token is not a JWT:",type(e).__name__); sys.exit(0)
json.dump(c,open(sys.argv[1],"w"),indent=2)
exp=c.get("exp"); now=datetime.datetime.now(datetime.timezone.utc).timestamp()
if exp and exp<now: print("WARNING: token expired at",datetime.datetime.fromtimestamp(exp,datetime.timezone.utc).isoformat())
elif exp: print("token exp: %s (%.1f h from now)"%(datetime.datetime.fromtimestamp(exp,datetime.timezone.utc).isoformat(),(exp-now)/3600))
print("token claims:",",".join(sorted(c)))
' "$OUT/token-claims.json"
chmod 600 "$OUT/token-claims.json" 2>/dev/null

# step NAME FILE CURL_ARGS... -> prints "NAME: HTTP <code>, <bytes> bytes, <file>"
step() {
  local name="$1" file="$2"; shift 2
  local code
  code=$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS -o "$file" -w '%{http_code}' -H @- "${HDRS[@]}" "$@" 2>"$OUT/.curl_err") \
    || code="curl-error($(tr -d '\n' < "$OUT/.curl_err"))"
  [ -f "$file" ] && chmod 600 "$file"
  printf '%-22s HTTP %s, %s bytes, %s\n' "$name:" "$code" "$( [ -f "$file" ] && wc -c < "$file" | tr -d ' ' || echo 0)" "$file"
  sleep 1   # no documented rate limit; be polite
}

# 1. /api/me: confirms the token and gives the user id
step "me" "$OUT/me.json" "$BASE/api/me"
jq -r '"  id=\(.id // "?") total_workouts=\(.total_workouts // "?")"' "$OUT/me.json" 2>/dev/null
USER_ID="${PELOTON_USER_ID:-}"
[ -n "$USER_ID" ] || USER_ID=$(jq -r '.id // empty' "$OUT/me.json" 2>/dev/null)
if [ -z "$USER_ID" ]; then
  echo "no user id: /api/me did not return one (expired or wrong token?). Response:"
  head -c 400 "$OUT/me.json"; echo
  exit 1
fi

# 2. 20 most recent workouts. Spec example joins is "peloton.ride"; also try ride,ride.instructor.
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

# 3. Newest workout detail and performance graph every_n=60. The spec's example joins
#    "peloton,peloton.ride,..." now return 400 "Bad joins"; ride,ride.instructor,user work.
step "workout" "$OUT/workout_$WID.json" -G "$BASE/api/workout/$WID" \
  --data-urlencode "joins=ride,ride.instructor,user"
step "performance_graph" "$OUT/perf_$WID.json" -G "$BASE/api/workout/$WID/performance_graph" -d every_n=60
jq -r '"  metrics: \([.metrics[]?.slug]|join(",")) summaries: \([.summaries[]?.slug]|join(","))"' "$OUT/perf_$WID.json" 2>/dev/null

# 4. Ride details: GET /api/ride/{rideId}/details
RID=$(jq -r '.ride.id // .peloton.ride.id // empty' "$OUT/workout_$WID.json" 2>/dev/null)
[ -n "$RID" ] || RID=$(jq -r '.data[0].ride.id // empty' "$OUT/workouts_ride.json" 2>/dev/null)
if [ -n "$RID" ]; then
  step "ride_details" "$OUT/ride_$RID.json" "$BASE/api/ride/$RID/details"
  jq -r '"  top-level keys: \(keys|join(","))"' "$OUT/ride_$RID.json" 2>/dev/null
else
  echo "ride_details:          skipped (no ride id in workout detail; e.g. just-ride/free mode)"
fi

# 5. Overview (workout counts by discipline)
step "overview" "$OUT/overview.json" "$BASE/api/user/$USER_ID/overview"

# 6. CSV export: NOT IN SPEC. Opt-in only.
if [ "${PROBE_CSV:-0}" = "1" ]; then
  step "workout_history_csv" "$OUT/workout_history.csv" \
    "$BASE/api/user/$USER_ID/workout_history_csv?timezone=UTC"
fi
echo "done; outputs in $OUT (contain personal data; delete when finished)"
