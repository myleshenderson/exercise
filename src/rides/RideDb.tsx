import { createContext, useContext, type ReactNode } from "react";
import { db } from "../data";
import type { DataLayer } from "../data/DataLayer";

/**
 * The DataLayer every ride screen, hook and the Home strip read through (AI-649). Defaults to the
 * app's `db`; tests wrap a screen in `<RideDbProvider db={createRideFixtureDb()}>`. Ride code calls
 * DataLayer methods only, never Supabase.
 */
const RideDbContext = createContext<DataLayer>(db);

export function RideDbProvider({ db: value, children }: { db: DataLayer; children: ReactNode }) {
  return <RideDbContext.Provider value={value}>{children}</RideDbContext.Provider>;
}

export function useRideDb(): DataLayer {
  return useContext(RideDbContext);
}
