// FIT base types: size in bytes and the "invalid" sentinel per type.

export interface BaseType {
  size: number;
  /** Read one element at `offset`; `null` when it equals the invalid value. */
  read(view: DataView, offset: number, littleEndian: boolean): number | null;
}

function int(
  size: 1 | 2 | 4,
  signed: boolean,
  invalid: number,
): BaseType {
  return {
    size,
    read(view, offset, le) {
      const v =
        size === 1
          ? signed
            ? view.getInt8(offset)
            : view.getUint8(offset)
          : size === 2
            ? signed
              ? view.getInt16(offset, le)
              : view.getUint16(offset, le)
            : signed
              ? view.getInt32(offset, le)
              : view.getUint32(offset, le);
      return v === invalid ? null : v;
    },
  };
}

function int64(signed: boolean, invalid: bigint): BaseType {
  return {
    size: 8,
    read(view, offset, le) {
      const v = signed ? view.getBigInt64(offset, le) : view.getBigUint64(offset, le);
      return v === invalid ? null : Number(v);
    },
  };
}

function float(size: 4 | 8): BaseType {
  return {
    size,
    read(view, offset, le) {
      // Invalid is all bits set, which is a NaN.
      const v = size === 4 ? view.getFloat32(offset, le) : view.getFloat64(offset, le);
      return Number.isNaN(v) ? null : v;
    },
  };
}

/** Keyed by the base type number (low 5 bits of the base type byte). */
export const BASE_TYPES: Record<number, BaseType> = {
  0x00: int(1, false, 0xff), // enum
  0x01: int(1, true, 0x7f), // sint8
  0x02: int(1, false, 0xff), // uint8
  0x03: int(2, true, 0x7fff), // sint16
  0x04: int(2, false, 0xffff), // uint16
  0x05: int(4, true, 0x7fffffff), // sint32
  0x06: int(4, false, 0xffffffff), // uint32
  0x07: { size: 1, read: () => null }, // string (no kept field is a string)
  0x08: float(4), // float32
  0x09: float(8), // float64
  0x0a: int(1, false, 0x00), // uint8z
  0x0b: int(2, false, 0x0000), // uint16z
  0x0c: int(4, false, 0x00000000), // uint32z
  0x0d: int(1, false, 0xff), // byte
  0x0e: int64(true, 0x7fffffffffffffffn), // sint64
  0x0f: int64(false, 0xffffffffffffffffn), // uint64
  0x10: int64(false, 0n), // uint64z
};

export function baseTypeOf(byte: number): BaseType | undefined {
  return BASE_TYPES[byte & 0x1f];
}
