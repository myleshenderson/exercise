import { biggestClimbM, elevationGainM, smoothAltitude } from "./elevation";

describe("elevation", () => {
  const example = [100, 110, 105, 130, 115, 140];
  it("[100,110,105,130,115,140]: biggest climb 30 m, gain 60 m", () => {
    expect(biggestClimbM(example)).toBe(30);
    expect(elevationGainM(example)).toBe(60);
  });
  it("gain ignores wobble under 2 m and skips nulls", () => {
    expect(elevationGainM([100, 101, 100, 101.5, 102, null, 104])).toBe(4);
    expect(elevationGainM([100, 98, 100])).toBe(2);
  });
  it("a drop below the climb start closes the climb", () => {
    expect(biggestClimbM([100, 105, 95, 120])).toBe(25);
  });
  it("a dip of exactly 10 m does not close the climb", () => {
    expect(biggestClimbM([100, 120, 110, 130])).toBe(30);
  });
  it("is null for empty or all-null, 0 for a single sample", () => {
    expect(elevationGainM([])).toBeNull();
    expect(biggestClimbM([])).toBeNull();
    expect(elevationGainM([null, null])).toBeNull();
    expect(biggestClimbM([null, null])).toBeNull();
    expect(elevationGainM([100])).toBe(0);
    expect(biggestClimbM([null, 100])).toBe(0);
  });
});

describe("smoothAltitude", () => {
  it("takes a centred 5-sample mean over non-null neighbours", () => {
    expect(smoothAltitude([0, 10, 20, 30, 40])).toEqual([10, 15, 20, 25, 30]);
    expect(smoothAltitude([0, null, 20, null, 40])).toEqual([10, 10, 20, 30, 30]);
  });
  it("keeps length and gives null where no neighbour is present", () => {
    expect(smoothAltitude([])).toEqual([]);
    expect(smoothAltitude([null, null, null])).toEqual([null, null, null]);
    expect(smoothAltitude([100, null, null, null, null, null, null])).toEqual([100, 100, 100, null, null, null, null]);
  });
});
