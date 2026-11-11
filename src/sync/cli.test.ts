import { describe, expect, it } from "vitest";
import { SYNC_USAGE, SyncUsageError, parseSyncArgs, providersOf } from "./cli.js";

describe("parseSyncArgs", () => {
  it.each([
    [["--source", "garmin", "--full"], { source: "garmin", mode: "full" }],
    [["--source", "peloton", "--incremental"], { source: "peloton", mode: "incremental" }],
    [["--incremental", "--source=all"], { source: "all", mode: "incremental" }],
    [
      ["--source", "peloton", "--full", "--recompute-all"],
      { source: "peloton", mode: "full", recomputeAll: true, reseedPelotonToken: false },
    ],
    [
      ["--source", "peloton", "--incremental", "--reseed-peloton-token"],
      { source: "peloton", mode: "incremental", recomputeAll: false, reseedPelotonToken: true },
    ],
    [["--source", "all", "--full", "--reseed-peloton-token", "--recompute-all"], { recomputeAll: true, reseedPelotonToken: true }],
  ] as const)("(f) accepts %j", (argv, expected) => {
    expect(parseSyncArgs(argv)).toMatchObject({ recomputeAll: false, reseedPelotonToken: false, ...expected, help: false });
  });

  it.each([
    [[], "--source is required"],
    [["--full"], "--source is required"],
    [["--source", "garmin"], "exactly one of --full and --incremental"],
    [["--source", "garmin", "--full", "--incremental"], "exactly one of --full and --incremental"],
    [["--source", "strava", "--full"], "--source must be garmin, peloton or all"],
    [["--source"], "--source needs a value"],
    [["--source", "--full"], "--source needs a value"],
    [["--source", "garmin", "--source", "peloton", "--full"], "more than once"],
    [["--source", "garmin", "--full", "--verbose"], "unknown argument: --verbose"],
    [["--source", "garmin", "--full", "extra"], "unknown argument: extra"],
    [["--source", "garmin", "--full", "--reseed-peloton-token"], "--reseed-peloton-token needs --source peloton or all"],
  ] as const)("(f) rejects %j", (argv, message) => {
    expect(() => parseSyncArgs(argv)).toThrowError(SyncUsageError);
    expect(() => parseSyncArgs(argv)).toThrowError(message);
  });

  it("usage errors carry the usage text", () => {
    try {
      parseSyncArgs(["--bogus"]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain(SYNC_USAGE);
    }
  });

  it.each([[["--help"]], [["-h"]], [["--source", "garmin", "--full", "--incremental", "--help"]]])(
    "(f) --help wins: %j",
    (argv) => {
      expect(parseSyncArgs(argv).help).toBe(true);
    },
  );

  it("--help still rejects unknown arguments", () => {
    expect(() => parseSyncArgs(["--help", "--nope"])).toThrowError("unknown argument: --nope");
  });
});

describe("providersOf", () => {
  it("expands all", () => {
    expect(providersOf("all")).toEqual(["garmin", "peloton"]);
    expect(providersOf("garmin")).toEqual(["garmin"]);
    expect(providersOf("peloton")).toEqual(["peloton"]);
  });
});
