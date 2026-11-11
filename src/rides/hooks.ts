import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_ATHLETE_SETTINGS, type DataLayer } from "../data/DataLayer";
import { formatDistance, formatElevation, formatSpeed, formatWeight, type Units } from "../metrics/units";
import { formatDuration, type DurationStyle } from "../metrics/display";
import type { AthleteSettings } from "../types";
import { useRideDb } from "./RideDb";

export interface AthleteSettingsState {
  /** The stored settings; `DEFAULT_ATHLETE_SETTINGS` (imperial, Monday) until loaded. */
  settings: AthleteSettings;
  loaded: boolean;
  error: Error | null;
  /**
   * Calls `saveAthleteSettings(patch)`, applies the stored row, then re-reads the settings.
   * Rejects only when the save itself fails; a failed re-read is reported through `error`.
   */
  save(patch: Partial<AthleteSettings>): Promise<AthleteSettings>;
  refresh(): Promise<void>;
}

/** The athlete's settings through `useRideDb()`, with a save that refreshes them. */
export function useAthleteSettings(): AthleteSettingsState {
  const db = useRideDb();
  const [settings, setSettings] = useState<AthleteSettings>(DEFAULT_ATHLETE_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // The db whose results may still be applied: cleared on unmount, replaced when the provider
  // swaps db, so a late read from an old db never overwrites newer state.
  const live = useRef<DataLayer | null>(db);

  const refresh = useCallback(async () => {
    try {
      const s = await db.getAthleteSettings();
      if (live.current !== db) return;
      setSettings(s);
      setError(null);
    } catch (e) {
      if (live.current !== db) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (live.current === db) setLoaded(true);
    }
  }, [db]);

  useEffect(() => {
    live.current = db;
    void refresh();
    return () => {
      live.current = null;
    };
  }, [db, refresh]);

  const save = useCallback(
    async (patch: Partial<AthleteSettings>) => {
      const stored = await db.saveAthleteSettings(patch); // rejects when the save fails
      if (live.current === db) {
        setSettings(stored);
        setError(null);
      }
      await refresh(); // best effort: a failed re-read sets `error`, it does not undo the save
      return stored;
    },
    [db, refresh],
  );

  return { settings, loaded, error, save, refresh };
}

export interface UnitFormatters {
  units: Units;
  /** Metres → "64.7 mi" / "104.1 km". */
  distance(m: number | null | undefined): string;
  /** Metres → "1,048 ft" / "319 m". */
  elevation(m: number | null | undefined): string;
  /** m/s → "18.6 mph" / "30.0 km/h". */
  speed(mps: number | null | undefined): string;
  /** kg → "176.4 lb" / "80.0 kg". */
  weight(kg: number | null | undefined): string;
  /** Seconds → "3h 28m" (short, default) or "7:25:23" (clock). */
  duration(s: number | null | undefined, style?: DurationStyle): string;
}

/** Formatters for an explicit unit system (all delegate to `src/metrics`). */
export function unitFormatters(units: Units): UnitFormatters {
  return {
    units,
    distance: (m) => formatDistance(m ?? null, units),
    elevation: (m) => formatElevation(m ?? null, units),
    speed: (mps) => formatSpeed(mps ?? null, units),
    weight: (kg) => formatWeight(kg ?? null, units),
    duration: (s, style = "short") => formatDuration(s, style),
  };
}

/**
 * Formatters bound to `settings.units` (imperial until the settings load, decision 11). Pass the
 * settings when the screen already holds them, to avoid a second read.
 */
export function useUnits(settings?: Pick<AthleteSettings, "units">): UnitFormatters {
  const own = useOwnSettingsUnlessGiven(settings);
  const units = settings?.units ?? own;
  return useMemo(() => unitFormatters(units), [units]);
}

function useOwnSettingsUnlessGiven(given: Pick<AthleteSettings, "units"> | undefined): Units {
  const db = useRideDb();
  const [units, setUnits] = useState<Units>(DEFAULT_ATHLETE_SETTINGS.units);
  const skip = given !== undefined;
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    db.getAthleteSettings().then(
      (s) => {
        if (!cancelled) setUnits(s.units);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [db, skip]);
  return units;
}
