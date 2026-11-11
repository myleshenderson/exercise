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

PELOTON_USERNAME=... PELOTON_PASSWORD=... bash scripts/probes/peloton-probe.sh
# add PROBE_CSV=1 to also try the undocumented workout_history_csv export
```

Endpoints come from `garmin/connect-personal-api-python` (Garmin's official client) and
`pelo-tech/peloton-api-spec` (unofficial, 2021).
