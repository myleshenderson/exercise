import { bestEffortDistances, fastestDistance, personalRecords, type RecordRide } from "./bestEfforts";

describe("bestEffortDistances", () => {
  it("lists the 12 distance rows of decision 8 in order", () => {
    expect(bestEffortDistances.map((d) => [d.label, d.distanceM])).toEqual([
      ["5 mile", 8046.72],
      ["10K", 10000],
      ["10 mile", 16093.44],
      ["20K", 20000],
      ["30K", 30000],
      ["40K", 40000],
      ["50K", 50000],
      ["80K", 80000],
      ["50 mile", 80467.2],
      ["90K", 90000],
      ["100K", 100000],
      ["100 mile", 160934.4],
    ]);
  });
});

describe("fastestDistance", () => {
  it("cum [0,10,20,40,60,70,80], D 40 gives 2 s", () => {
    expect(fastestDistance([0, 10, 20, 40, 60, 70, 80], 40)).toBe(2);
  });
  it("interpolates the start inside a second", () => {
    expect(fastestDistance([0, 10, 20, 30], 15)).toBeCloseTo(1.5, 9);
  });
  it("includes pauses (elapsed time) and picks the latest start during a pause", () => {
    expect(fastestDistance([0, 10, 10, 10, 20], 20)).toBe(4);
    expect(fastestDistance([0, 0, 0, 10, 20], 20)).toBe(2);
  });
  it("skips null samples", () => {
    expect(fastestDistance([0, null, 20, null, 40], 40)).toBe(4);
    expect(fastestDistance([null, 0, 10, null, 30], 15)).toBeCloseTo(1.5, 9);
  });
  it("is null when the ride is shorter than D, empty, all-null, or D is not positive", () => {
    expect(fastestDistance([0, 10, 20], 40)).toBeNull();
    expect(fastestDistance([], 40)).toBeNull();
    expect(fastestDistance([null, null], 40)).toBeNull();
    expect(fastestDistance([0, 10], 0)).toBeNull();
  });
});

describe("personalRecords", () => {
  const steady = (mps: number, seconds: number) => Array.from({ length: seconds + 1 }, (_, i) => i * mps);
  const rides: RecordRide[] = [
    { id: "o1", environment: "outdoor", distanceM: 10000, elevationGainM: 300, biggestClimbM: 120, cumDistanceM: steady(10, 1000) },
    { id: "o2", environment: "outdoor", distanceM: 9000, elevationGainM: 500, biggestClimbM: 80, cumDistanceM: steady(12, 750) },
    { id: "i1", environment: "indoor", distanceM: 50000, elevationGainM: 0, biggestClimbM: 0, cumDistanceM: steady(20, 2500) },
    { id: "o3", environment: "outdoor", distanceM: null, elevationGainM: null, biggestClimbM: null },
  ];
  it("ranks outdoor rides only", () => {
    const pr = personalRecords(rides);
    expect(pr.longestRideM).toEqual({ value: 10000, activityId: "o1" });
    expect(pr.biggestClimbM).toEqual({ value: 120, activityId: "o1" });
    expect(pr.mostElevationM).toEqual({ value: 500, activityId: "o2" });
    expect(pr.distances).toHaveLength(12);
    expect(pr.distances[0].label).toBe("5 mile");
    expect(pr.distances[0].record?.activityId).toBe("o2");
    expect(pr.distances[0].record?.value).toBeCloseTo(8046.72 / 12, 6);
    expect(pr.distances[1].record).toEqual({ value: 1000, activityId: "o1" });
    expect(pr.distances.slice(2).every((d) => d.record === null)).toBe(true);
  });
  it("is all null for empty or indoor-only input", () => {
    for (const input of [[], rides.filter((r) => r.environment === "indoor")]) {
      const pr = personalRecords(input);
      expect(pr.longestRideM).toBeNull();
      expect(pr.biggestClimbM).toBeNull();
      expect(pr.mostElevationM).toBeNull();
      expect(pr.distances.every((d) => d.record === null)).toBe(true);
    }
  });
});
