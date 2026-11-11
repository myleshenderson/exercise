import * as metrics from "./index";

describe("metrics index", () => {
  it("re-exports every topic", () => {
    for (const name of [
      "normalizedPower", "intensityFactor", "tssFromPower", "workKj", "meanMaxPower", "STANDARD_DURATIONS_S",
      "tssForActivity", "strengthSessionTss", "ftpAt", "eftp", "dailyLoad", "loadStep", "bestEffortDistances",
      "fastestDistance", "personalRecords", "smoothAltitude", "elevationGainM", "biggestClimbM", "weightTrend",
      "wPerKg", "mToMi", "mToFt", "kgToLb", "mpsToMph", "cToF", "formatDistance", "formatElevation", "formatSpeed",
      "formatWeight", "localDate",
    ]) {
      expect(metrics).toHaveProperty(name);
    }
  });
});
