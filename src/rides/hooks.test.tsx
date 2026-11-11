import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMockDataLayer } from "../data/mock";
import { DEFAULT_ATHLETE_SETTINGS } from "../data/DataLayer";
import { db as appDb } from "../data";
import { RideDbProvider, useRideDb } from "./RideDb";
import { unitFormatters, useAthleteSettings, useUnits } from "./hooks";

function wrapperFor(db = createMockDataLayer()) {
  return { db, wrapper: ({ children }: { children: ReactNode }) => <RideDbProvider db={db}>{children}</RideDbProvider> };
}

test("useRideDb defaults to the app's db and is overridden by the provider", () => {
  expect(renderHook(() => useRideDb()).result.current).toBe(appDb);
  const { db, wrapper } = wrapperFor();
  expect(renderHook(() => useRideDb(), { wrapper }).result.current).toBe(db);
});

test("useAthleteSettings loads, saves through saveAthleteSettings and refreshes", async () => {
  const { db, wrapper } = wrapperFor();
  const spy = vi.spyOn(db, "saveAthleteSettings");
  const { result } = renderHook(() => useAthleteSettings(), { wrapper });
  expect(result.current.settings).toEqual(DEFAULT_ATHLETE_SETTINGS);
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => {
    await result.current.save({ manualFtpW: 260, units: "metric" });
  });
  expect(spy).toHaveBeenCalledWith({ manualFtpW: 260, units: "metric" });
  expect(result.current.settings).toMatchObject({ manualFtpW: 260, units: "metric", weekStart: "monday" });

  await db.saveAthleteSettings({ weekStart: "sunday" });
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.settings.weekStart).toBe("sunday");
});

test("useAthleteSettings reports a load error", async () => {
  const { db, wrapper } = wrapperFor();
  db.getAthleteSettings = () => Promise.reject(new Error("nope"));
  const { result } = renderHook(() => useAthleteSettings(), { wrapper });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.error?.message).toBe("nope");
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.error?.message).toBe("nope");
});

test("useUnits is imperial by default and follows settings.units", async () => {
  const { db, wrapper } = wrapperFor();
  const { result, rerender } = renderHook(() => useUnits(), { wrapper });
  expect(result.current.units).toBe("imperial");
  expect(result.current.distance(1609.344)).toBe("1.0 mi");
  await db.saveAthleteSettings({ units: "metric" });
  const second = renderHook(() => useUnits(), { wrapper });
  await waitFor(() => expect(second.result.current.units).toBe("metric"));
  expect(second.result.current.distance(1000)).toBe("1.0 km");
  rerender();
  const given = renderHook(() => useUnits({ units: "metric" }), { wrapper });
  expect(given.result.current.weight(80)).toBe("80.0 kg");
});

test("unitFormatters delegate to src/metrics", () => {
  const imp = unitFormatters("imperial");
  expect(imp.distance(null)).toBe("—");
  expect(imp.elevation(100)).toBe("328 ft");
  expect(imp.speed(10)).toBe("22.4 mph");
  expect(imp.weight(80)).toBe("176.4 lb");
  expect(imp.duration(12_480)).toBe("3h 28m");
  expect(imp.duration(726, "clock")).toBe("12:06");
  const met = unitFormatters("metric");
  expect(met.elevation(100)).toBe("100 m");
  expect(met.speed(10)).toBe("36.0 km/h");
  expect(met.distance(undefined)).toBe("—");
});

test("save rejects when the save fails, and a failed re-read after a good save only sets error", async () => {
  const { db, wrapper } = wrapperFor();
  const { result } = renderHook(() => useAthleteSettings(), { wrapper });
  await waitFor(() => expect(result.current.loaded).toBe(true));

  const saveSpy = vi.spyOn(db, "saveAthleteSettings").mockRejectedValueOnce(new Error("save failed"));
  await act(async () => {
    await expect(result.current.save({ lthrBpm: 170 })).rejects.toThrow("save failed");
  });
  expect(result.current.settings.lthrBpm).toBeNull();
  saveSpy.mockRestore();

  vi.spyOn(db, "getAthleteSettings").mockRejectedValueOnce(new Error("read failed"));
  let stored: unknown;
  await act(async () => {
    stored = await result.current.save({ lthrBpm: 171 });
  });
  expect(stored).toMatchObject({ lthrBpm: 171 });
  expect(result.current.settings.lthrBpm).toBe(171);
  expect(result.current.error?.message).toBe("read failed");
});

test("a late read after unmount is ignored", async () => {
  const { db, wrapper } = wrapperFor();
  let release: () => void = () => {};
  db.getAthleteSettings = () => new Promise((resolve) => {
    release = () => resolve({ ...DEFAULT_ATHLETE_SETTINGS, units: "metric" });
  });
  const { result, unmount } = renderHook(() => useAthleteSettings(), { wrapper });
  unmount();
  await act(async () => release());
  expect(result.current.loaded).toBe(false);
});
