# API probes (owner-run)

Read-only probes that capture what the Garmin Personal API and Peloton's private API
return for one account, so the integration (Linear epic AI-627) is built against real
responses instead of third-party write-ups. Agent containers cannot reach either host;
run these on your own machine with `curl`, `jq` and `python3` on PATH.

Neither script prints a secret. Keys, passwords and session tokens travel to curl on
stdin or in a mode-600 temp file; outputs land in `./garmin-probe-out/` and
`./peloton-probe-out/` (gitignored). Outputs contain personal data: delete them when done.

```bash
export GARMIN_API_KEY=...        # from https://connect.garmin.com/app/settings/personalApiToken
bash scripts/probes/garmin-probe.sh

export PELOTON_BEARER_TOKEN=...   # see "Peloton token" below
bash scripts/probes/peloton-probe.sh
# add PROBE_CSV=1 to also try the undocumented workout_history_csv export
```

## Peloton token

Peloton retired password login (`POST /auth/login`) in late 2025; it now answers
403 "Endpoint no longer accepting requests" for any credentials, and the web app signs
in through Auth0 with a browser flow. The probe therefore takes a bearer token copied
from your own signed-in session:

1. Sign in at https://members.onepeloton.com.
2. Open DevTools > Network, reload, and click any request to `api.onepeloton.com/api/...`.
3. Copy the value of the `Authorization` request header (with or without the leading
   `Bearer `) into `PELOTON_BEARER_TOKEN`.

Tokens last about 48 hours. `PELOTON_USER_ID=...` skips the `/api/me` lookup. The probe
saves only the token's decoded claims (`token-claims.json`), never the token itself.

Endpoints come from `garmin/connect-personal-api-python` (Garmin's official client) and
`pelo-tech/peloton-api-spec` (unofficial, 2021; its login section is obsolete, see above).
