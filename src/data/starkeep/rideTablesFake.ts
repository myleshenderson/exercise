/**
 * Test-only: the eight ride tables as AI-824 declares them in
 * `starkeep.manifest.json` (epic AI-822: the Supabase columns minus `user_id`
 * and `updated_at`, a text `id` primary key, `timestamptz` → timestamp, `date`
 * → text, `double precision`/`numeric` → real, `int` → integer, `jsonb` and
 * arrays → text), for `createFakeTransport`.
 *
 * AI-824 and AI-825 land in parallel, so the tests take the manifest's tables
 * and add from here only the ride tables the manifest does not declare yet
 * ({@link withRideTables}). Once the manifest declares them, its declaration
 * is the one the tests run against.
 */
import type { FakeColumn, FakeTable } from "./fakeTransport.js";

const id: FakeColumn = { name: "id", type: "text", primaryKey: true, notNull: true };
const createdAt: FakeColumn = { name: "created_at", type: "timestamp", notNull: true };
const col = (name: string, type: string, notNull = false): FakeColumn => ({ name, type, ...(notNull ? { notNull } : {}) });

export const RIDE_FAKE_TABLES: FakeTable[] = [
  {
    name: "external_activities",
    columns: [
      id,
      col("source", "text", true),
      col("source_id", "text", true),
      col("started_at", "timestamp", true),
      col("timezone", "text"),
      col("sport", "text", true),
      col("sub_type", "text"),
      col("environment", "text", true),
      col("title", "text"),
      ...[
        "elapsed_s", "moving_s", "distance_m", "elevation_gain_m", "avg_speed_mps", "max_speed_mps", "avg_power_w",
        "max_power_w", "normalized_power_w", "intensity_factor", "tss", "work_kj", "calories", "avg_hr_bpm",
        "max_hr_bpm", "avg_cadence_rpm", "biggest_climb_m",
      ].map((n) => col(n, "real")),
      col("tss_source", "text"),
      col("ftp_used_w", "integer"),
      col("ftp_source", "text"),
      col("has_power", "boolean", true),
      col("has_hr", "boolean", true),
      col("power_curve", "text"),
      col("best_efforts", "text"),
      col("paired_activity_id", "text"),
      col("provider_payload", "text", true),
      col("synced_at", "timestamp", true),
      createdAt,
    ],
  },
  {
    name: "activity_streams",
    columns: [id, col("activity_id", "text", true), col("channel", "text", true), col("start_offset_s", "integer", true), col("values", "text", true), createdAt],
  },
  {
    name: "body_weights",
    columns: [
      id,
      col("source", "text", true),
      col("source_id", "text", true),
      col("measured_at", "timestamp", true),
      col("weight_kg", "real", true),
      ...["bmi", "body_fat_pct", "body_water_pct", "muscle_mass_kg", "bone_mass_kg"].map((n) => col(n, "real")),
      col("provider_payload", "text", true),
      createdAt,
    ],
  },
  {
    name: "athlete_settings",
    columns: [
      id,
      ...["manual_ftp_w", "lthr_bpm", "max_hr_bpm", "resting_hr_bpm"].map((n) => col(n, "integer")),
      col("strength_session_tss", "real", true),
      col("no_power_tss_per_hour", "real", true),
      col("units", "text", true),
      col("week_start", "text", true),
      createdAt,
    ],
  },
  {
    name: "ftp_history",
    columns: [id, col("effective_from", "timestamp", true), col("ftp_w", "integer", true), col("source", "text", true), col("source_ref", "text"), createdAt],
  },
  {
    name: "daily_training_load",
    columns: [
      id,
      col("date", "text", true),
      col("tss_total", "real", true),
      col("tss_by_source", "text", true),
      col("ctl", "real", true),
      col("atl", "real", true),
      col("tsb", "real", true),
      createdAt,
    ],
  },
  {
    name: "sync_state",
    columns: [
      id,
      col("source", "text", true),
      col("cursor", "text"),
      col("last_run_at", "timestamp"),
      col("last_success_at", "timestamp"),
      col("items_fetched", "integer", true),
      col("items_upserted", "integer", true),
      col("last_error", "text"),
      col("backfill_complete", "boolean", true),
      col("auth_status", "text", true),
      createdAt,
    ],
  },
  {
    name: "provider_credentials",
    columns: [
      id,
      col("provider", "text", true),
      col("ciphertext", "text", true),
      col("iv", "text", true),
      col("auth_tag", "text", true),
      col("key_id", "text", true),
      col("access_expires_at", "timestamp"),
      col("rotated_at", "timestamp"),
      col("revoked_at", "timestamp"),
      createdAt,
    ],
  },
];

/** `tables` plus every ride table from {@link RIDE_FAKE_TABLES} that `tables` does not declare. */
export function withRideTables(tables: readonly FakeTable[]): FakeTable[] {
  const declared = new Set(tables.map((t) => t.name));
  return [...tables, ...RIDE_FAKE_TABLES.filter((t) => !declared.has(t.name))];
}
