import { describe, expect, it } from "vitest";
import { decodeFit, FitError } from "./index.js";
import { fitCrc } from "./crc.js";
import { BT, chain, data, def, encodeFit, type FitItem } from "./testing/encodeFit.js";

// FIT seconds 1_000_000_000 = Unix 1_631_065_600 = 2021-09-08T01:46:40Z.
const T0 = 1_000_000_000;
const U0 = 1_631_065_600;

const RECORD_FIELDS = [
  { num: 253, baseType: BT.uint32 }, // timestamp
  { num: 0, baseType: BT.sint32 }, // position_lat
  { num: 1, baseType: BT.sint32 }, // position_long
  { num: 5, baseType: BT.uint32 }, // distance
  { num: 73, baseType: BT.uint32 }, // enhanced_speed
  { num: 78, baseType: BT.uint32 }, // enhanced_altitude
  { num: 13, baseType: BT.sint8 }, // temperature
  { num: 3, baseType: BT.uint8 }, // heart_rate
];

const NULLS = {
  altitude: null,
  heart_rate: null,
  cadence: null,
  speed: null,
  power: null,
};

function ride(): FitItem[] {
  return [
    def(0, 20, RECORD_FIELDS),
    data(0, [T0, 536870912, -536870912, 123456, 5250, 3000, 21, null]),
    data(0, [T0 + 1, 268435456, 0, 123556, 5500, 3005, -3, 140]),
  ];
}

const RIDE_RECORDS = [
  {
    ...NULLS,
    timestamp: U0,
    position_lat: 45,
    position_long: -45,
    distance: 1234.56,
    enhanced_speed: 5.25,
    enhanced_altitude: 100,
    temperature: 21,
  },
  {
    ...NULLS,
    timestamp: U0 + 1,
    position_lat: 22.5,
    position_long: 0,
    distance: 1235.56,
    enhanced_speed: 5.5,
    enhanced_altitude: 101,
    temperature: -3,
    heart_rate: 140,
  },
];

describe("decodeFit", () => {
  it("decodes record fields with scale and offset applied", () => {
    const m = decodeFit(encodeFit(ride()));
    // semicircle 536870912 -> 45°, enhanced_altitude 3000 -> 100 m,
    // distance 123456 -> 1234.56 m, FIT time + 631065600 -> Unix seconds.
    expect(m.records).toEqual(RIDE_RECORDS);
    expect(m.laps).toEqual([]);
    expect(m.sessions).toEqual([]);
    expect(m.events).toEqual([]);
    expect(m.sets).toEqual([]);
  });

  it("decodes speed, altitude, power and cadence from the non-enhanced fields", () => {
    const m = decodeFit(
      encodeFit([
        def(0, 20, [
          { num: 253, baseType: BT.uint32 },
          { num: 2, baseType: BT.uint16 },
          { num: 6, baseType: BT.uint16 },
          { num: 7, baseType: BT.uint16 },
          { num: 4, baseType: BT.uint8 },
        ]),
        data(0, [T0, 2600, 8125, 250, 90]),
      ]),
    );
    expect(m.records[0]).toMatchObject({
      timestamp: U0,
      altitude: 20, // 2600 / 5 - 500
      speed: 8.125,
      power: 250,
      cadence: 90,
      enhanced_speed: null,
      enhanced_altitude: null,
    });
  });

  it("maps each base type's invalid value to null", () => {
    const m = decodeFit(
      encodeFit([
        def(0, 20, RECORD_FIELDS),
        data(0, [T0, null, null, null, null, null, null, null]),
      ]),
    );
    expect(m.records).toEqual([
      {
        ...NULLS,
        timestamp: U0,
        position_lat: null,
        position_long: null,
        distance: null,
        enhanced_speed: null,
        enhanced_altitude: null,
        temperature: null,
      },
    ]);
  });

  it("decodes a big-endian file the same as a little-endian one", () => {
    const le = encodeFit(ride());
    const be = encodeFit(ride(), { bigEndian: true });
    expect(be).not.toEqual(le);
    expect(decodeFit(be)).toEqual(decodeFit(le));
    expect(decodeFit(be).records).toEqual(RIDE_RECORDS);
  });

  it("reads a 12-byte header and a 14-byte header with a zero CRC", () => {
    expect(decodeFit(encodeFit(ride(), { headerSize: 12 })).records).toEqual(RIDE_RECORDS);
    expect(decodeFit(encodeFit(ride(), { zeroHeaderCrc: true })).records).toEqual(RIDE_RECORDS);
  });

  it("places compressed-timestamp records on the right seconds across a 32 s rollover", () => {
    const start = T0 + 30; // low 5 bits = 30
    const m = decodeFit(
      encodeFit([
        def(1, 20, [
          { num: 253, baseType: BT.uint32 },
          { num: 5, baseType: BT.uint32 },
        ]),
        data(1, [start, 0]),
        def(2, 20, [{ num: 5, baseType: BT.uint32 }]),
        data(2, [100], { timeOffset: 31 }), // start + 1
        data(2, [200], { timeOffset: 0 }), // rolls over: start + 2
        data(2, [500], { timeOffset: 3 }), // start + 5
        data(2, [3500], { timeOffset: 1 }), // rolls over again: start + 35
      ]),
    );
    expect(m.records.map((r) => [r.timestamp, r.distance])).toEqual([
      [1_631_065_630, 0],
      [1_631_065_631, 1],
      [1_631_065_632, 2],
      [1_631_065_635, 5],
      [1_631_065_665, 35],
    ]);
  });

  it("gives a compressed-timestamp record no timestamp when no full timestamp came first", () => {
    const m = decodeFit(
      encodeFit([def(0, 20, [{ num: 5, baseType: BT.uint32 }]), data(0, [100], { timeOffset: 4 })]),
    );
    expect(m.records[0].timestamp).toBeNull();
    expect(m.records[0].distance).toBe(1);
  });

  it("skips developer fields by size", () => {
    const m = decodeFit(
      encodeFit([
        // developer_data_id (207) and field_description (206) are unknown here and skipped.
        def(3, 207, [{ num: 3, baseType: BT.uint8 }]),
        data(3, [0]),
        def(4, 206, [
          { num: 0, baseType: BT.uint8 },
          { num: 1, baseType: BT.uint8 },
          { num: 3, baseType: BT.string, size: 8 },
        ]),
        data(4, [0, 0, null]),
        def(0, 20, RECORD_FIELDS, {
          devFields: [
            { num: 0, size: 4, devIndex: 0 },
            { num: 1, size: 3, devIndex: 0 },
          ],
        }),
        data(0, [T0, 536870912, -536870912, 123456, 5250, 3000, 21, null], {
          dev: [0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46],
        }),
        data(0, [T0 + 1, 268435456, 0, 123556, 5500, 3005, -3, 140]),
      ]),
    );
    expect(m.records).toEqual(RIDE_RECORDS);
  });

  it("skips unknown message 534 and unknown fields of kept messages", () => {
    const m = decodeFit(
      encodeFit([
        def(0, 534, [
          { num: 0, baseType: BT.uint32 },
          { num: 1, baseType: BT.string, size: 11 },
          { num: 2, baseType: BT.uint16, size: 6 },
          { num: 253, baseType: BT.uint32 },
        ]),
        data(0, [7, null, 9, T0 + 50]),
        def(1, 20, [
          { num: 253, baseType: BT.uint32 },
          { num: 200, baseType: BT.uint64 }, // unknown record field
          { num: 5, baseType: BT.uint32 },
          { num: 201, baseType: BT.float32 },
        ]),
        data(1, [T0, 77, 123456, 1.5]),
      ]),
    );
    expect(m.records).toEqual([
      {
        ...NULLS,
        timestamp: U0,
        position_lat: null,
        position_long: null,
        distance: 1234.56,
        enhanced_speed: null,
        enhanced_altitude: null,
        temperature: null,
      },
    ]);
  });

  it("follows a local type redefined to a different message", () => {
    const m = decodeFit(
      encodeFit([
        def(0, 20, [{ num: 253, baseType: BT.uint32 }]),
        data(0, [T0]),
        def(0, 21, [
          { num: 253, baseType: BT.uint32 },
          { num: 0, baseType: BT.enum },
          { num: 1, baseType: BT.enum },
        ]),
        data(0, [T0 + 5, 0, 4]),
      ]),
    );
    expect(m.records.map((r) => r.timestamp)).toEqual([U0]);
    expect(m.events).toEqual([{ timestamp: U0 + 5, event: 0, event_type: 4 }]);
  });

  it("decodes a set message: weight raw 1600 is 100 kg, timestamp is field 254", () => {
    const m = decodeFit(
      encodeFit([
        def(0, 225, [
          { num: 254, baseType: BT.uint32 },
          { num: 0, baseType: BT.uint32 },
          { num: 3, baseType: BT.uint16 },
          { num: 4, baseType: BT.uint16 },
          { num: 5, baseType: BT.uint8 },
          { num: 6, baseType: BT.uint32 },
          { num: 7, baseType: BT.uint16, size: 4 },
          { num: 8, baseType: BT.uint16, size: 4 },
          { num: 10, baseType: BT.uint16 }, // message_index, not kept
        ]),
        data(0, [T0 + 40, 32500, 10, 1600, 1, T0, 28, 5, 0]),
      ]),
    );
    expect(m.sets).toEqual([
      {
        timestamp: U0 + 40,
        duration: 32.5,
        repetitions: 10,
        weight: 100,
        set_type: 1,
        start_time: U0,
        category: 28,
        category_subtype: 5,
      },
    ]);
  });

  it("decodes lap and session messages", () => {
    const totals = [
      { num: 253, baseType: BT.uint32 },
      { num: 2, baseType: BT.uint32 },
      { num: 7, baseType: BT.uint32 },
      { num: 8, baseType: BT.uint32 },
      { num: 9, baseType: BT.uint32 },
    ];
    const m = decodeFit(
      encodeFit([
        def(0, 19, totals),
        data(0, [T0 + 600, T0, 600500, 590250, 500000]),
        def(1, 18, [...totals, { num: 5, baseType: BT.enum }, { num: 6, baseType: BT.enum }]),
        data(1, [T0 + 600, T0, 600500, 590250, 500000, 2, 7]),
      ]),
    );
    const lap = {
      timestamp: U0 + 600,
      start_time: U0,
      total_elapsed_time: 600.5,
      total_timer_time: 590.25,
      total_distance: 5000,
    };
    expect(m.laps).toEqual([lap]);
    expect(m.sessions).toEqual([{ ...lap, sport: 2, sub_sport: 7 }]);
  });

  it("decodes chained FIT files in sequence", () => {
    const second = encodeFit([
      def(0, 20, [{ num: 253, baseType: BT.uint32 }]),
      data(0, [T0 + 2]),
    ]);
    const m = decodeFit(chain(encodeFit(ride()), second));
    expect(m.records.map((r) => r.timestamp)).toEqual([U0, U0 + 1, U0 + 2]);
  });

  it("does not carry local definitions into a chained file", () => {
    const first = encodeFit([def(0, 20, [{ num: 253, baseType: BT.uint32 }]), data(0, [T0])]);
    // A chained file whose data message uses local 0 without defining it.
    const orphan = encodeRaw([0x00, 0, 0, 0, 0]);
    expect(() => decodeFit(chain(first, orphan))).toThrow(/undefined local type 0/);
  });

  it("fills a set message's field-254 timestamp from a compressed header", () => {
    const m = decodeFit(
      encodeFit([
        def(0, 20, [{ num: 253, baseType: BT.uint32 }]),
        data(0, [T0]),
        def(1, 225, [{ num: 3, baseType: BT.uint16 }]),
        data(1, [12], { timeOffset: 10 }),
      ]),
    );
    expect(m.sets[0]).toMatchObject({ timestamp: U0 + 10, repetitions: 12 });
  });

  it("maps a relative date_time (below 0x10000000) to null", () => {
    const m = decodeFit(encodeFit([def(0, 20, [{ num: 253, baseType: BT.uint32 }]), data(0, [1234])]));
    expect(m.records[0].timestamp).toBeNull();
  });

  it("counts compressed times only from a uint32 field 253", () => {
    const m = decodeFit(
      encodeFit([
        def(0, 20, [{ num: 253, baseType: BT.uint32 }]),
        data(0, [T0]),
        def(1, 534, [{ num: 253, baseType: BT.uint16 }]), // not a date_time
        data(1, [7]),
        def(2, 20, [{ num: 5, baseType: BT.uint32 }]),
        data(2, [100], { timeOffset: 3 }),
      ]),
    );
    expect(m.records.map((r) => r.timestamp)).toEqual([U0, U0 + 3]);
  });

  it("ignores zero padding after the last file", () => {
    const padded = chain(encodeFit(ride()), new Uint8Array(4));
    expect(decodeFit(padded).records).toEqual(RIDE_RECORDS);
  });

  describe("rejects malformed input with FitError", () => {
    const good = () => encodeFit(ride());

    it("bad file CRC", () => {
      expect(() => decodeFit(encodeFit(ride(), { corruptCrc: true }))).toThrow(FitError);
      expect(() => decodeFit(encodeFit(ride(), { corruptCrc: true }))).toThrow(/file CRC/);
    });

    it("bad header CRC", () => {
      expect(() => decodeFit(encodeFit(ride(), { corruptHeaderCrc: true }))).toThrow(/header CRC/);
    });

    it("missing .FIT signature", () => {
      const bytes = good();
      bytes[9] = 0x58;
      expect(() => decodeFit(bytes)).toThrow(/signature/);
    });

    it("empty input, short header and unsupported header size", () => {
      expect(() => decodeFit(new Uint8Array())).toThrow(FitError);
      expect(() => decodeFit(good().slice(0, 10))).toThrow(/truncated/);
      const bytes = good();
      bytes[0] = 13;
      expect(() => decodeFit(bytes)).toThrow(/header size 13/);
    });

    it("data size past the end of the file", () => {
      expect(() => decodeFit(good().slice(0, -3))).toThrow(/past the end/);
    });

    it("trailing bytes that are not a FIT header", () => {
      expect(() => decodeFit(chain(good(), new Uint8Array([1, 2, 3])))).toThrow(/truncated/);
    });

    it("a message that runs past the data section", () => {
      // Definition says 5 fields but the data section ends after 2.
      expect(() => decodeFit(encodeRaw([0x40, 0, 0, 20, 0, 5, 253, 4, 0x86]))).toThrow(
        /past the data section/,
      );
    });

    it("a bad architecture byte", () => {
      expect(() => decodeFit(encodeRaw([0x40, 0, 2, 20, 0, 0]))).toThrow(/architecture/);
    });
  });
});

/** Wrap raw data-section bytes in a valid 14-byte header and CRC. */
function encodeRaw(body: number[]): Uint8Array {
  const out = new Uint8Array(14 + body.length + 2);
  const view = new DataView(out.buffer);
  out[0] = 14;
  out[1] = 0x20;
  view.setUint32(4, body.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8);
  view.setUint16(12, fitCrc(out, 0, 12), true);
  out.set(body, 14);
  view.setUint16(14 + body.length, fitCrc(out, 0, 14 + body.length), true);
  return out;
}
