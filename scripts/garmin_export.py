#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["garminconnect>=0.2.19"]
# ///
"""Export full Garmin weigh-in history to local files.

Usage:
    uv run scripts/garmin_export.py

First run prompts for Garmin email/password (and MFA code if enabled);
tokens are cached in ~/.garminconnect/ so later runs don't prompt.

Writes (overwriting on each run):
    data/garmin/weigh_ins.csv       flattened history, oldest first
    data/garmin/weigh_ins_raw.json  raw per-year API responses
"""

import csv
import json
import sys
from datetime import date
from getpass import getpass
from pathlib import Path

from garminconnect import Garmin

TOKENSTORE = "~/.garminconnect"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "garmin"
EMPTY_YEARS_TO_STOP = 3
MIN_YEAR = 2000

GRAMS_PER_KG = 1000
LB_PER_KG = 2.20462


def login() -> Garmin:
    try:
        api = Garmin()
        api.login(TOKENSTORE)
        print("Logged in with cached tokens.")
        return api
    except Exception as err:
        # garth raises its own error types on missing/expired tokens; any
        # failure here just means we fall through to a fresh interactive login.
        print(f"No usable cached tokens ({type(err).__name__}); logging in fresh.")

    email = input("Garmin email: ").strip()
    password = getpass("Garmin password: ")
    api = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("MFA code: ").strip(),
    )
    api.login(TOKENSTORE)
    print("Logged in; tokens cached for next time.")
    return api


def grams_to_kg(value):
    return round(value / GRAMS_PER_KG, 2) if value is not None else None


def fetch_all(api: Garmin):
    """Walk backward year by year until EMPTY_YEARS_TO_STOP empty years."""
    raw_by_year = {}
    rows = []
    empty_streak = 0
    year = date.today().year

    while year >= MIN_YEAR and empty_streak < EMPTY_YEARS_TO_STOP:
        start, end = f"{year}-01-01", f"{year}-12-31"
        data = api.get_body_composition(start, end)
        entries = (data or {}).get("dateWeightList") or []
        raw_by_year[str(year)] = data
        if entries:
            empty_streak = 0
            print(f"{year}: {len(entries)} weigh-ins")
        else:
            empty_streak += 1
            print(f"{year}: none")
        for e in entries:
            weight_kg = grams_to_kg(e.get("weight"))
            rows.append(
                {
                    "calendar_date": e.get("calendarDate"),
                    "weight_kg": weight_kg,
                    "weight_lb": round(weight_kg * LB_PER_KG, 1) if weight_kg else None,
                    "bmi": e.get("bmi"),
                    "body_fat_pct": e.get("bodyFat"),
                    "body_water_pct": e.get("bodyWater"),
                    "muscle_mass_kg": grams_to_kg(e.get("muscleMass")),
                    "bone_mass_kg": grams_to_kg(e.get("boneMass")),
                    "source": e.get("sourceType"),
                }
            )
        year -= 1

    rows.sort(key=lambda r: r["calendar_date"] or "")
    return rows, raw_by_year


def main() -> int:
    api = login()
    rows, raw = fetch_all(api)
    if not rows:
        print("No weigh-ins found; nothing written.")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUT_DIR / "weigh_ins.csv"
    json_path = OUT_DIR / "weigh_ins_raw.json"

    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    json_path.write_text(json.dumps(raw, indent=2))

    print(f"\nWrote {len(rows)} weigh-ins ({rows[0]['calendar_date']} → "
          f"{rows[-1]['calendar_date']}) to {csv_path}")
    print(f"Raw responses in {json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
