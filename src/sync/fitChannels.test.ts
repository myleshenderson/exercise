import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { FitError } from "../fit/index.js";
import { BT, data, def, encodeFit } from "../fit/testing/encodeFit.js";
import { channelsFromFit } from "./fitChannels.js";

const T0 = 1_000_000_000; // FIT seconds

// record: timestamp, power (W), heart_rate (bpm), distance (cm)
const fit = encodeFit([
  def(0, 20, [
    { num: 253, baseType: BT.uint32 },
    { num: 7, baseType: BT.uint16 },
    { num: 3, baseType: BT.uint8 },
    { num: 5, baseType: BT.uint32 },
  ]),
  data(0, [T0, 200, 120, 0]),
  data(0, [T0 + 1, 210, 121, 1000]),
  data(0, [T0 + 3, 220, 122, 3000]),
]);

describe("channelsFromFit", () => {
  const expected = {
    power: [200, 210, null, 220],
    heart_rate: [120, 121, null, 122],
    distance: [0, 10, null, 30],
  };

  it("decodes a bare FIT into channels without timestamp", () => {
    expect(channelsFromFit(fit, "fit")).toEqual(expected);
  });

  it("decodes a zipped FIT", () => {
    expect(channelsFromFit(zipSync({ "1_ACTIVITY.fit": fit }), "zip")).toEqual(expected);
  });

  it("lets FitError propagate", () => {
    expect(() => channelsFromFit(new Uint8Array([1, 2, 3]), "fit")).toThrow(FitError);
    expect(() => channelsFromFit(zipSync({ "a.txt": new Uint8Array([1]) }), "zip")).toThrow(FitError);
  });
});
