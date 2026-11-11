/**
 * The reads the ride analytics MCP tools need (AI-654): the eight DataLayer read methods, by
 * name and signature, so either backend can hand over its own (Starkeep its DataLayer, Supabase
 * the `src/data/supabase.ts` functions over a user-scoped client). Declared here rather than
 * picked from `src/data/DataLayer.ts`, because nothing under `src/analysis/` imports `src/data/`;
 * a DataLayer satisfies it structurally.
 */
import type {
  ActivityEnvironment,
  ActivitySource,
  ActivityStream,
  AthleteSettings,
  BodyWeight,
  DailyTrainingLoad,
  ExternalActivity,
  FtpHistoryEntry,
  SyncState,
} from "../../types.js";

/** Same contract as `ExternalActivityFilter` in `src/data/DataLayer.ts`. */
export interface RideActivityFilter {
  /** Inclusive lower bound on startedAt (ISO instant). */
  from?: string;
  /** Inclusive upper bound on startedAt (ISO instant). */
  to?: string;
  source?: ActivitySource;
  environment?: ActivityEnvironment;
  limit?: number;
}

export interface RideReads {
  /** Newest first. */
  listExternalActivities(f: RideActivityFilter): Promise<ExternalActivity[]>;
  getExternalActivity(id: string): Promise<ExternalActivity | null>;
  /** Ordered by channel. */
  getActivityStreams(activityId: string): Promise<ActivityStream[]>;
  /** measuredAt in [from, to], oldest first. */
  listBodyWeights(from: string, to: string): Promise<BodyWeight[]>;
  /** The column defaults when the user has no row. */
  getAthleteSettings(): Promise<AthleteSettings>;
  /** Oldest effectiveFrom first. */
  listFtpHistory(): Promise<FtpHistoryEntry[]>;
  /** date in [from, to], oldest first. */
  listDailyTrainingLoad(from: string, to: string): Promise<DailyTrainingLoad[]>;
  /** Ordered by source. */
  listSyncState(): Promise<SyncState[]>;
}
