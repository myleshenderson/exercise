/** FTP history from Peloton workout details (`ftp_info`, AI-627 payload facts 8 and 12.9). */
import type { FtpHistoryEntry, FtpSource } from "../../types.js";
import type { PelotonWorkout, PelotonWorkoutDetail } from "./types.js";

const SOURCE_MAP: Record<string, FtpSource> = {
  ftp_workout_source: "peloton_test",
  ftp_manual_source: "peloton_manual",
};

/** FTP tests are looked up (ride details `is_ftp_test`) only for classes titled like one. */
export const FTP_TITLE = /\bFTP\b/i;

export function looksLikeFtpTest(w: PelotonWorkout): boolean {
  const title = w.ride?.title;
  return typeof title === "string" && FTP_TITLE.test(title);
}

/**
 * The FTP in force for a workout as a history entry; null for an unknown source or an FTP of 0
 * or less. `knownStarts` maps workout id → startedAt and dates a test-derived FTP from its test.
 */
export function ftpFromWorkout(
  detail: PelotonWorkoutDetail,
  startedAt: string,
  knownStarts: Map<string, string>,
): Omit<FtpHistoryEntry, "id"> | null {
  const info = detail.ftp_info;
  if (!info) return null;
  const source = SOURCE_MAP[info.ftp_source];
  if (!source || typeof info.ftp !== "number" || !Number.isFinite(info.ftp) || info.ftp <= 0) return null;
  const ref = info.ftp_workout_id ?? null;
  return {
    effectiveFrom: (ref !== null ? knownStarts.get(ref) : undefined) ?? startedAt,
    ftpW: info.ftp,
    source,
    sourceRef: ref,
  };
}
