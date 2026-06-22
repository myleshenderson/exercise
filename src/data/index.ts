import type { DataLayer } from "./DataLayer";
import { createMockDataLayer } from "./mock";

// Swap to "supabase" via VITE_DATA_BACKEND once the Supabase impl lands (Task 13).
const backend = import.meta.env.VITE_DATA_BACKEND ?? "mock";

export const db: DataLayer =
  backend === "supabase"
    ? (() => { throw new Error("Supabase backend not yet wired (Task 13)"); })()
    : createMockDataLayer();
