# Ride analytics plan

Planning page for AI-627, 2026-11-11. Garmin supplies outdoor rides and body weight, Peloton supplies indoor rides, and the exercise app supplies strength. The HTML version has the phone mockups; this file describes each screen in a paragraph.

## 1. Where we are

Myles has decided to cancel Strava and make this app the holistic view of his training: Garmin for outdoor riding and body weight, Peloton for indoor riding, and the app itself for strength, with Myles-only credentials in Vercel env, Supabase first with Starkeep parity later, and a backfill of everything. This page is the input for scoping: it lays out the data, the maths, the storage, the sync and the proposed screens so he can choose what gets built first. It is not a ticket list; issues get filed under AI-627 after he scopes.

## 2. What Strava gave a cyclist, and what we keep

Routes, segments, clubs and the social feed are out of scope. The Strava research came from search excerpts; where Strava's method is unpublished we use the published TrainingPeaks equivalent.

| Strava feature | Tier | What we do | Computed from |
|---|---|---|---|
| Ride summary: distance, moving time, speed, elevation, cadence | Free | Build now | Garmin FIT stream; Peloton summary fields |
| Average and max power, calories | Free | Build now | FIT stream; Peloton performance_graph |
| Weighted Average Power | Subscriber | Build now as NP | 1 s power stream |
| Intensity and Training Load | Subscriber | Build now as IF and TSS | NP plus FTP |
| Estimated power without a meter | Free | Drop: +5% to −35% error; HR-only rides get hrTSS | n/a |
| Power and HR zone distribution per ride | Subscriber | Build now | power and HR streams |
| Per-ride power curve, 25 W histogram | Subscriber | Build later | power stream |
| Relative Effort | Subscriber | Drop: coefficients unpublished; TSS and hrTSS cover it | n/a (archive keeps old values) |
| Laps and splits | Free | Build later | FIT lap messages |
| Perceived exertion, private notes | Free | Build later | entered in the app |
| Gear mileage | Free | Drop: Garmin Connect already tracks gear | n/a |
| Athlete Intelligence summaries | Subscriber | Drop: Claude answers through MCP | n/a |
| My Stats: last 4 weeks, year, all-time | Free | Build now | summary fields |
| Best Efforts by distance, longest ride, most elevation | Subscriber | Build now | Garmin FIT distance stream; summary fields |
| Biggest Climb | Subscriber | Build now | FIT altitude stream |
| Power bests (5 s to 1 h) | Subscriber | Build now | power streams (MMP) |
| Progress summary chart | Free | Build later | summary fields |
| Training Log | Subscriber | Build now as the Activities feed | summary fields |
| Fitness and Freshness | Subscriber | Build now (Training screen) | daily TSS |
| Power curve with W/kg and estimated FTP | Subscriber | Build now | per-ride MMP; body weight |
| Zones from FTP and max HR | Subscriber | Build now (Settings) | athlete settings |
| Goals | Subscriber | Build later | summary fields |
| Body weight (one profile value, no history) | Free | Build now, with full history | Garmin weight range |
| Strava archive (activities.csv, original FIT files) | Free | Request before cancelling; import is a one-off and optional | activities.csv joined to FIT files on Filename |

**Request the Strava archive before cancelling** (Settings → Download your data → Request your archive). It holds activities.csv (about 84 columns, including Relative Effort and weighted average watts) and the original .fit.gz files. Cancelling deletes nothing, but importing from the archive is the clean path because the Strava API terms restrict display and require deletion on disconnect.

## 3. Sources

The container has no network route to Garmin or Peloton, so every UNVERIFIED fact waits on the probe scripts Myles runs.

**Garmin Personal API.** Provides activity search (paged, date filter, typeKey), activity detail, original FIT zip, weight by date range, dailies, sleep and HRV; strength sets only through FIT set messages. Auth: Myles's personal key in Vercel env, exchanged for a 24 h JWT. Constraints: pull-only JSON, no webhooks, no backfill endpoint, no Training API; full history means paging newest-first until an empty page. Unverified: weight units (grams per forum reports), rate limits and page sizes. The key shared in chat must be rotated.

**Peloton private API.** Provides the workouts list (paged, with ride joins), workout detail with ftp_info, and performance_graph with 1 s power, cadence, resistance, HR and speed plus summaries (distance, calories, output). Auth: username and password in Vercel env; password login returns a session cookie sent with `peloton-platform: web`. Constraints: unofficial (a 2021 community spec), pull-only, no webhooks, can break without notice. Unverified: Peloton moved login to Auth0 after that spec, so whether password login still works is the main probe question.

**exercise app.** Provides strength sessions and sets in `sessions` and `session_sets`, and the MCP server. Auth: Supabase with RLS; the sync writes through the service role as `SYNC_OWNER_USER_ID`. Constraints: strength-only schema with no sync, cron or token storage yet; `mcp_sessions` is the precedent for a service-role-only table; MCP tools keep parity across Supabase and Starkeep; migrations, `api/` and `vercel.json` are merged by Myles.

## 4. How the numbers are defined

FTP comes from Settings, with history, so every TSS can be recomputed when it changes.

- **Normalized Power** (TrainingPeaks; Strava's Weighted Average Power is a close cousin with an unpublished formula): `NP = (mean(rolling30s(power)^4))^(1/4)`
- **IF and TSS** (TrainingPeaks): `IF = NP / FTP`, `TSS = hours × IF² × 100`. One hour at FTP scores 100; a stale FTP inflates both.
- **hrTSS fallback** for HR-only rides (TrainingPeaks, community-fitted curve, UNVERIFIED): `TSS per hour ≈ 1.3277 × e^(0.044035 × %LTHR)`
- **Strength TSS**: `TSS = strength_session_tss` per session, default 50 (TrainingPeaks: one hour at RPE 4 ≈ 50; intervals.icu example 32/h).
- **CTL, ATL, TSB** (TrainingPeaks, intervals.icu), seeded at 0:

  ```
  CTL_t = CTL_{t-1} × e^(-1/42) + TSS_t × (1 - e^(-1/42))
  ATL_t = ATL_{t-1} × e^(-1/7)  + TSS_t × (1 - e^(-1/7))
  TSB_t = CTL_{t-1} - ATL_{t-1}   (TrainingPeaks; intervals.icu uses today)
  ```
  Bands: below −30 overreaching, −30 to −10 productive, −10 to +5 grey zone, +5 to +25 fresh, above +25 transition.
- **Ramp rate** (TrainingPeaks): `CTL_today - CTL_7_days_ago`; +4 to +8 a week is a steady build.
- **Power curve and eFTP** (Peloton FTP test; intervals.icu): resample to 1 Hz, zero-fill gaps, prefix sums, `MMP(d) = max (S[i+d] - S[i]) / d` at 1 s, 5 s, 15 s, 30 s, 1, 2, 5, 10, 20, 30, 60, 90, 120 min, stored per ride and maxed over a window. `eFTP = 0.95 × MMP(20 min)`; a critical-power fit `P = CP + W'/t` on 3 to 20 min efforts can come later. eFTP decay is UNVERIFIED.
- **Best efforts** (Strava support: ranked by elapsed time; moving versus elapsed UNVERIFIED): two pointers over cumulative distance, boundary times interpolated, minimum elapsed time per distance.
- **Biggest climb and elevation gain** (Strava support, Garmin ClimbPro): count a rise only after 2 m (barometric) or 10 m (GPS) of consistent climbing; biggest climb is the largest continuous ascent, allowing dips up to 10 m.
- **Weight trend and W/kg** (Hacker's Diet, Libra; bands from Coggan via Garmin): 7-day average, `trend_t = trend_{t-1} + 0.1 × (W_t - trend_{t-1})`, rate per week from the last 28 days, `W/kg = FTP / kg`.

| Zone | Coggan power, % FTP | Friel bike HR, % LTHR | Garmin HR, % max |
|---|---|---|---|
| 1 | < 55 | < 81 | 50–60 |
| 2 | 56–75 | 81–89 | 60–70 |
| 3 | 76–90 | 90–93 | 70–80 |
| 4 | 91–105 | 94–99 | 80–90 |
| 5 | 106–120 | 100–102 / 103–106 / > 106 | 90–100 |
| 6 | 121–150 | | |
| 7 | > 150 | | |

## 5. Storage

- `external_activities`: user_id, source (garmin, peloton, strava_export), source_id, unique (user_id, source, source_id); sport, sub_type, environment, title, started_at, duration_s, moving_duration_s, distance_m, elevation_gain_m, calories, avg_hr, max_hr, avg_power_w, normalized_power_w, total_work_j, intensity_factor, tss, tss_method, best_efforts jsonb, biggest_climb_m, power_curve jsonb, hr_zones_s jsonb, power_zones_s jsonb, raw jsonb, synced_at.
- `activity_streams`: activity_id → external_activities, kind (power, hr, cadence, altitude, distance, speed), every_n seconds, values array.
- `body_weights`: source, source_id, measured_at, weight_kg, bmi, body_fat_pct, muscle_mass_kg, bone_mass_kg, body_water_pct, raw.
- `athlete_settings`: user_id pk, ftp_watts, ftp_source, threshold_hr, max_hr, resting_hr, strength_session_tss (50), units ('imperial'), week_start ('monday').
- `ftp_history`: effective_from, ftp_watts, source (peloton_test, manual, estimated).
- `sync_state`: source pk, cursor jsonb, last_run_at, last_success_at, last_error, backfill_complete.
- `daily_training_load`: date, tss_total, tss_by_sport jsonb, ctl, atl, tsb; rebuilt nightly and in full when settings change.
- Existing `sessions` and `session_sets` stay as they are; the read model unions them in as sport 'strength'.

Every new table has RLS limiting reads to the owner's rows. The sync writes through the Supabase service role and stamps rows with `user_id = SYNC_OWNER_USER_ID`; `sync_state` has no client policy, like `mcp_sessions`. The browser and MCP tools only read through the user's session. `activity_streams` exists so a change of FTP or threshold HR can recompute NP, IF, TSS and zone times without downloading anything again, and so the activity screen can draw its charts.

## 6. Sync and compute pipeline

Garmin API and Peloton API → **fetch** (CLI full backfill from Myles's machine, `npm run sync -- --source all --full`; daily Vercel cron `/api/sync` with CRON_SECRET, 60 s max, resumable cursor) → **decode** (FIT through @garmin/fitsdk; Peloton performance_graph at every_n = 1) → **compute** (NP, IF, TSS, hrTSS, best efforts, biggest climb, MMP, zone times) → **upsert** (external_activities, activity_streams, body_weights) → **nightly rollup** (daily_training_load with CTL, ATL, TSB) → **read models** (screens, MCP tools).

One runner in `src/sync` keeps a per-source cursor and deadline and upserts on (user_id, source, source_id). Garmin's daily run looks back three days past the last success; Peloton's stops at the first known workout id. Weight is fetched by calendar year back to 2000, stopping after three empty years.

**Overlap rule.** A Garmin activity and a Peloton workout starting within 10 minutes of each other are one ride. Stats count it once; Peloton supplies power, title and instructor, Garmin supplies heart rate and elevation.

## 7. Screens

The proposed bottom bar adds Activities and Stats; Training, Power curve and Weight open from Stats. Sample figures in the HTML mockups assume FTP 250 W, threshold HR 168, max HR 186.

**Activities feed (`/activities`).** A unified list with sport filter chips (All, Rides, Outdoor, Indoor, Strength) and week headers carrying weekly totals (rides, hours, TSS, kJ). Each row has a source badge (Garmin, Peloton, Strength), title, headline numbers and a TSS chip. Paired Garmin and Peloton recordings show as one Peloton row noting HR from Garmin. Reads external_activities, sessions and athlete_settings.week_start.

**Activity detail (`/activities/:id`).** For a Garmin outdoor ride: a stats grid (distance, moving time, elevation, average and max HR, average speed, average power, NP, IF, TSS, kJ, calories), three stacked charts on one time axis (altitude, power, HR), power and HR zone bars, best efforts achieved in the ride with the PR beside each, biggest climb, and a link to Garmin Connect. A Peloton variant shows output, average output, cadence, resistance, class title and instructor, with a note such as "Paired with the Garmin Indoor Cycling recording that started at 06:02". Reads external_activities, activity_streams and athlete_settings.

**My Stats (`/stats`).** The Cycling tab reproduces Strava's four blocks with Myles's numbers: Last 4 Weeks (4 activities/week, 64.7 mi, 1,048 ft, 3h 28m), Best Efforts (longest ride 100.7 mi, biggest climb 2,114 ft, most elevation 9,111 ft, then 5 mile 12:06 through 100 mile 7:25:23), 2026 (78 activities, 1,772.2 mi, 48,855 ft, 115h 40m) and All-Time (882, 12,653.7 mi, 248,667 ft, 778h 50m), plus a power-bests strip for 5 s, 1 min, 5 min, 20 min and 1 h. The Strength tab shows sessions, sets and volume per week and all-time totals; a weight card shows latest weigh-in, 7-day average and 4-week change.

**Training (`/training`).** Weekly TSS bars for 12 weeks stacked by outdoor, indoor and strength; a fitness and fatigue chart (CTL, ATL) above a form (TSB) panel with the five bands shaded; a ramp-rate readout; and time in power zone per week as 100% bars for the last six weeks. Reads daily_training_load and zone seconds.

**Power curve (`/power`).** Best power for every duration on a log time axis, all-time against the last 90 days, a dashed eFTP line (95% of the 90-day 20-minute best), a W versus W/kg toggle and a small table of key durations. Reads per-ride power_curve and body_weights.

**Weight (`/weight`).** Weigh-ins as dots with a 7-day average line over 30 days, 90 days, a year or all; readouts for rate per week, latest weigh-in, 4-week change, and W/kg at the current FTP with its band. Reads body_weights and athlete_settings.

**Settings (`/settings`).** FTP with its history, threshold HR, max HR, strength session TSS (default 50), units (imperial), week start, and sync status per source with the last run, what it brought in, and a Sync now button. Saving FTP or strength TSS triggers a recompute.

**Home "This week" strip (grey area, suggestion only).** A small card above Today's Workout with rides, hours, TSS and latest weight for the current week. Reads daily_training_load and body_weights.

## 8. MCP tools

- `list_activities`: what did I ride last week, and which were indoor?
- `get_activity`: how did Saturday's ride compare with my bests, and where did I spend time above threshold?
- `activity_stats`: how far have I ridden this year compared with last year at this point?
- `training_load`: am I fresh enough for a hard week, and how fast is fitness rising?
- `power_curve`: is my 5-minute power better than in the spring?
- `weight_history`: what is my 90-day weight trend, and what is my W/kg now?
- `sync_status`: when did Garmin and Peloton last sync, and did anything fail?

## 9. Waves for scoping

Sizes: S under a day of agent work, M one moderate PR, L a large PR or two. "Myles merges" marks the production path (migrations, `api/`, `vercel.json`).

- **W1 foundation.** Schema migration and DataLayer methods with RLS (L, Myles merges). Maths module, pure and unit-tested (M). FIT decode module (M). Probes (S, Myles runs).
- **W2 ingestion.** Garmin sync (L). Peloton sync with overlap pairing (M). CLI backfill and first full run (S, Myles runs). Strava archive import, only if decided (M).
- **W3 surfaces.** MCP tools (M, Myles merges: registration touches `api/mcp.ts`). Activities feed and detail (L). My Stats (M). Training (M). Power curve (S). Weight (S). Settings with recompute (M).
- **W4 ops.** `/api/sync` cron endpoint and `vercel.json` schedule (S, Myles merges). Vercel env vars and docs (S, Myles sets). Later: Starkeep parity (L), other health series (M).

## 10. Decisions for Myles

- [ ] Which screens are in the first cut.
- [ ] TSB convention: yesterday's CTL − ATL (TrainingPeaks, proposed) or today's (intervals.icu).
- [ ] Strength TSS: fixed 50 per session (proposed), 32 per hour, or none.
- [ ] Best-efforts list: Strava's 11 distances or the 13 on his profile (adds 5 mile and 30K).
- [ ] Import the Strava archive at all: Garmin and Peloton hold full history; the archive adds Strava-only years and Relative Effort values.
- [ ] eFTP method: 95% of best 20 minutes first, or a critical-power fit.
- [ ] Imperial units by default (storage stays metric).
- [ ] Whether the Home "This week" strip is wanted.
- [ ] Whether Peloton rides count toward distance best efforts (Strava excludes virtual rides; proposal follows Strava).

## 11. Owner actions now

1. Request the Strava archive before the subscription ends.
2. Run the two probe scripts on branch `AI-627-probes` (see `scripts/probes/README.md`) and attach the outputs to Linear AI-627.
3. Rotate the Garmin key shared in the session, then put the new one in Vercel env.
4. Record FTP and threshold HR so the first TSS numbers are right.
