import type { DataLayer } from "./DataLayer";
import { createMockDataLayer } from "./mock";
import { createSupabaseDataLayer } from "./supabase";

const backend = import.meta.env.VITE_DATA_BACKEND ?? "mock";

export const db: DataLayer =
  backend === "supabase" ? createSupabaseDataLayer() : createMockDataLayer();
