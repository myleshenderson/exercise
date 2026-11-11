# Ride sync: owner runbook

Garmin rides and weight and Peloton workouts reach `external_activities`, `activity_streams`,
`body_weights`, `ftp_history` and `daily_training_load` through one runner,
`src/sync/runner.ts` (AI-641). It has two entry points:

- **CLI** `scripts/sync.ts` (`npm run sync`): run by the owner from his machine. It does the
  first full backfill, which takes hours, and the Peloton reconnect.
- **Cron** `api/sync.ts` (`GET /api/sync`): Vercel calls it once a day at 10:00 UTC
  (`vercel.json`; about 05:00 or 06:00 in New York, as Hobby allows daily crons only). It runs an
  incremental Garmin + Peloton sync with a 50 s budget inside the 60 s function limit, and
  answers with counts and error strings only.

Both write `sync_state` (one row per `garmin_activities`, `garmin_weight` and `peloton`: the
resumable cursor, last success, last error and auth status) and then recompute
`daily_training_load` from the day before the earliest ride written (at least the last 7
days, so strength sessions logged this week count).

The pipeline is section 6 of `docs/plans/2026-11-11-ride-analytics-plan.md`.

## Environment

| Variable | Purpose | Where |
| --- | --- | --- |
| `SUPABASE_URL` | The Supabase project the sync writes to. | both (Vercel already has it) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key; the sync bypasses RLS and stamps every row with the owner's id. | both (Vercel already has it) |
| `SYNC_OWNER_USER_ID` | The `auth.users` id whose rows the sync reads and writes. | both |
| `GARMIN_API_KEY` | Garmin Connect Personal API key; exchanged for a short-lived JWT on each run. | both |
| `PELOTON_REFRESH_TOKEN` | Bootstrap only: an Auth0 refresh token for Peloton. Used while no credential row exists, and by `--reseed-peloton-token`. After the first run the encrypted database copy wins (it rotates on every use), so a stale value here is harmless. | `.env.local` (Vercel optional) |
| `PELOTON_AUTH0_CLIENT_ID` | The `azp` claim of a Peloton access token (Myles supplies it). | both |
| `CREDENTIALS_KEY` | AES-256-GCM key for `provider_credentials`: `openssl rand -base64 32`. **The same value in both places**, or the cron cannot decrypt what the CLI stored. Changing it requires a reseed. | both |
| `CRON_SECRET` | Vercel sends `Authorization: Bearer $CRON_SECRET` to the cron; anything else gets 401. Any long random string (`openssl rand -hex 32`). | Vercel |
| `SYNC_DEFAULT_TIMEZONE` | IANA zone for "today" and for rides without a zone. Default `America/New_York`. | both (optional) |

A Garmin-only CLI run does not need the Peloton variables or `CREDENTIALS_KEY`; the cron needs
all of them. A missing variable fails the run with one error naming every missing one.

## Runbook

1. **Fill `.env.local`** in the repo root with the variables above (`npm run sync` loads it
   with `tsx --env-file-if-exists=.env.local`; without the file every variable must come from
   the shell, and `npm run sync -- --help` works with neither).
2. **Backfill from your machine**, one source at a time:

   ```bash
   npm run sync -- --source garmin --full
   npm run sync -- --source peloton --full --recompute-all
   ```

   These are the first full backfills; the cron never does them. `--recompute-all` on the last
   one recomputes every ride's TSS with the full FTP history and prior-ride eFTP, which a
   single pass cannot know, then rebuilds the daily load. Each run prints one line per source
   (fetched, upserted, skipped, done, error) and exits 1 when any source has an error. The
   cursor is saved as it goes: **rerun the same command to resume** after an interruption or
   a `done false` line.
3. **Set the Vercel env vars** (Production): `SYNC_OWNER_USER_ID`, `GARMIN_API_KEY`,
   `PELOTON_AUTH0_CLIENT_ID`, `CREDENTIALS_KEY` (same value as `.env.local`), `CRON_SECRET`,
   and optionally `SYNC_DEFAULT_TIMEZONE`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   are already set for the MCP functions. `scripts/set-sync-env.sh` does this step and
   step 2 together: it generates `CREDENTIALS_KEY` and `CRON_SECRET` once, prompts for the
   rest (secrets without echo, never on argv), writes `.env.local`, and pushes the same
   values to Vercel Production with `vercel env add --force`. Rerunning it keeps saved values.
4. **Merge.** Vercel registers the cron on the production deploy; its first run is at the next
   10:00 UTC, so the day after the merge. Check it in Vercel → Project → Cron Jobs, or call it
   yourself:

   ```bash
   curl -s -H "Authorization: Bearer $CRON_SECRET" https://<production-host>/api/sync
   ```

5. **Reconnect Peloton** when `sync_state.peloton.auth_status` is `reconnect_required` (the
   stored refresh token was revoked or expired): paste a new refresh token into
   `.env.local` as `PELOTON_REFRESH_TOKEN` and run

   ```bash
   npm run sync -- --source peloton --incremental --reseed-peloton-token
   ```

## CLI reference

```text
npm run sync -- --source garmin|peloton|all --full|--incremental [--recompute-all] [--reseed-peloton-token]
npm run sync -- --help
```

Exactly one of `--full` and `--incremental` is required. Once a source's backfill is complete
both modes run incrementally; `--full` on a finished source is not a re-download. The reverse
also holds: the adapters backfill any source whose backfill is incomplete, whatever the mode,
so a cron run before the CLI backfill finishes chips at it 50 s a day. Run the CLI first.

The run's budget (6 h for the CLI, 50 s for the cron) is shared out per source: Garmin
activities, Garmin weight and Peloton each get an equal share of what is left when they start,
and time one does not use passes to the next. A `--source all --full` backfill therefore gives
Garmin activities about 2 h; rerun to resume. A provider `Retry-After` that would end past a
source's share ends that source with an error, leaving the ride in hand for the next run.
