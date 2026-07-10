# Garmin weigh-in export — design

**Date:** 2026-07-09
**Status:** approved (conversationally)

## Purpose

Give Myles (and Claude, via the workout-analysis flow) local access to his
years of Garmin weigh-in history. Explicitly **not** an app feature: no schema
changes, no UI, no sync service.

## Design

One self-contained Python script, `scripts/garmin_export.py`, run with
`uv run scripts/garmin_export.py` (PEP 723 inline metadata declares the
`garminconnect` dependency; uv resolves it automatically).

- **Auth:** resume cached tokens from `~/.garminconnect/` when present;
  otherwise prompt interactively for Garmin email, password (via `getpass`),
  and MFA code. Credentials are never written to the repo.
- **Fetch:** call `get_body_composition(start, end)` per calendar year,
  walking backward from the current year; stop after 3 consecutive empty
  years (capped at year 2000).
- **Output** (both under `data/garmin/`, which is gitignored):
  - `weigh_ins.csv` — one row per weigh-in: `calendar_date, weight_kg,
    weight_lb, bmi, body_fat_pct, body_water_pct, muscle_mass_kg,
    bone_mass_kg, source`. Garmin returns grams; the script converts.
  - `weigh_ins_raw.json` — untouched per-year API responses, so extra fields
    are never lost.
- **Re-runs** overwrite both files with the full history; no incremental
  state.

## Non-goals

Supabase import, scheduled sync, official Garmin Health API integration.

## Risks

`python-garminconnect` is an unofficial, reverse-engineered client; Garmin
may break it. Acceptable for a manually-run export.
