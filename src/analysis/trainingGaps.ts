import type { SessionRow } from "./rows";
import { compareDates, dayNumber } from "./sqlSemantics";

export interface TrainingGapsTables {
  sessions: readonly Pick<SessionRow, "performed_on">[];
}

export interface TrainingGapsResult {
  performed_on: string;
  /** Whole days since the previous distinct training date; null for the first. */
  days_since_prev: number | null;
}

/**
 * Days elapsed between consecutive distinct training dates. Mirrors
 * `public.training_gaps` in `supabase/migrations/0005_analysis_rpc.sql`.
 *
 * Postgres semantics reproduced: `select distinct performed_on` collapses
 * same-day sessions; `date - date` is an integer day count; `lag()` over
 * `order by performed_on` is null for the earliest date. Output is ordered by
 * `performed_on`, unique per row.
 */
export function trainingGaps(tables: TrainingGapsTables): TrainingGapsResult[] {
  const dates = [...new Set(tables.sessions.map((s) => s.performed_on))].sort(compareDates);
  return dates.map((performed_on, i) => ({
    performed_on,
    days_since_prev: i === 0 ? null : dayNumber(performed_on) - dayNumber(dates[i - 1]),
  }));
}
