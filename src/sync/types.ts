/** Shared types of the wave 2 sync core (AI-637). Pure: no I/O. */
import type { EftpRide } from "../metrics/index.js";
import type {
  ActivityEnvironment,
  ActivitySource,
  ActivityStreamInput,
  AthleteSettings,
  ExternalActivityInput,
  FtpHistoryEntry,
  StreamChannel,
  SyncSource,
} from "../types.js";

/** 1 Hz channels: index i is second i after `startedAt`; `null` is a missing second. */
export type Channels = Partial<Record<StreamChannel, (number | null)[]>>;

/**
 * A provider's ride as an adapter normalises it: the provider's own summary values, in SI
 * units. `sport` is always "cycling" and is set by `ingestActivity`.
 */
export interface ProviderActivity {
  source: ActivitySource;
  sourceId: string;
  startedAt: string;
  timezone: string | null;
  subType: string | null;
  environment: ActivityEnvironment;
  title: string | null;
  elapsedS: number | null;
  movingS: number | null;
  distanceM: number | null;
  elevationGainM: number | null;
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  calories: number | null;
  avgPowerW: number | null;
  maxPowerW: number | null;
  workKj: number | null;
  avgHrBpm: number | null;
  maxHrBpm: number | null;
  avgCadenceRpm: number | null;
  providerPayload: unknown;
}

export interface IngestContext {
  settings: AthleteSettings;
  ftpHistory: readonly FtpHistoryEntry[];
  /** Earlier rides' 20-minute bests, for eFTP. */
  priorRides: readonly EftpRide[];
}

export interface IngestResult {
  row: ExternalActivityInput;
  streams: ActivityStreamInput[];
}

export interface SyncRunResult {
  source: SyncSource | "strava_export";
  fetched: number;
  upserted: number;
  skipped: number;
  done: boolean;
  /** The earliest `startedAt` written in the run; null when nothing was written. */
  earliestAffected: string | null;
  error: string | null;
  /** Run-specific remarks for the operator, e.g. "ftp_history collapsed: 3". */
  notes?: string[];
}

/** A provider_credentials row (encrypted tokens; ciphertext, iv and authTag are base64). */
export interface StoredCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyId: string;
  accessExpiresAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
}
