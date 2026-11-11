/** Argument parsing for `npm run sync` (AI-641). Pure: scripts/sync.ts does the I/O. */
import type { SyncProvider } from "./runner.js";

export interface SyncArgs {
  source: SyncProvider | "all";
  mode: "full" | "incremental";
  recomputeAll: boolean;
  reseedPelotonToken: boolean;
  help: boolean;
}

export const SYNC_USAGE = `Usage: npm run sync -- --source garmin|peloton|all --full|--incremental [options]

  --source <s>             garmin, peloton or all (required)
  --full                   backfill the whole history (resumes where the last run stopped)
  --incremental            fetch what is new since the last success
  --recompute-all          after the sync, recompute every ride's TSS and the daily load
  --reseed-peloton-token   store PELOTON_REFRESH_TOKEN as the Peloton credential first (reconnect)
  --help                   print this help

Exactly one of --full and --incremental is required. Env comes from .env.local; see docs/ride-sync.md.`;

export class SyncUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${SYNC_USAGE}`);
    this.name = "SyncUsageError";
  }
}

const SOURCES = ["garmin", "peloton", "all"] as const;

/** Parses argv (without node and the script path). `--help` wins over every other check. */
export function parseSyncArgs(argv: readonly string[]): SyncArgs {
  let source: string | null = null;
  let full = false;
  let incremental = false;
  let recomputeAll = false;
  let reseedPelotonToken = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--full") full = true;
    else if (arg === "--incremental") incremental = true;
    else if (arg === "--recompute-all") recomputeAll = true;
    else if (arg === "--reseed-peloton-token") reseedPelotonToken = true;
    else if (arg === "--source" || arg.startsWith("--source=")) {
      if (source !== null) throw new SyncUsageError("--source given more than once");
      const value = arg === "--source" ? argv[++i] : arg.slice("--source=".length);
      if (value === undefined || value.startsWith("--")) throw new SyncUsageError("--source needs a value");
      source = value;
    } else throw new SyncUsageError(`unknown argument: ${arg}`);
  }

  if (help) return { source: "all", mode: "incremental", recomputeAll, reseedPelotonToken, help: true };
  if (source === null) throw new SyncUsageError("--source is required");
  if (!(SOURCES as readonly string[]).includes(source)) {
    throw new SyncUsageError(`--source must be garmin, peloton or all, not ${source}`);
  }
  if (full === incremental) throw new SyncUsageError("give exactly one of --full and --incremental");
  if (reseedPelotonToken && source === "garmin") {
    throw new SyncUsageError("--reseed-peloton-token needs --source peloton or all");
  }
  return {
    source: source as SyncArgs["source"],
    mode: full ? "full" : "incremental",
    recomputeAll,
    reseedPelotonToken,
    help: false,
  };
}

/** The adapters a parsed `--source` runs. */
export function providersOf(source: SyncArgs["source"]): SyncProvider[] {
  return source === "all" ? ["garmin", "peloton"] : [source];
}
