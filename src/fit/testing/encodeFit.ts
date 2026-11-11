// Test-only FIT encoder: builds synthetic FIT bytes so no real activity file
// enters the repo. Not exported from src/fit/index.ts.
import { fitCrc } from "../crc";

/** FIT base type bytes (with the endian-ability bit where the spec sets it). */
export const BT = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  sint16: 0x83,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  string: 0x07,
  float32: 0x88,
  uint8z: 0x0a,
  uint32z: 0x8c,
  byte: 0x0d,
  uint64: 0x8f,
} as const;

const SIZE: Record<number, number> = {
  0x00: 1, 0x01: 1, 0x02: 1, 0x03: 2, 0x04: 2, 0x05: 4, 0x06: 4, 0x07: 1,
  0x08: 4, 0x09: 8, 0x0a: 1, 0x0b: 2, 0x0c: 4, 0x0d: 1, 0x0e: 8, 0x0f: 8, 0x10: 8,
};

const INVALID: Record<number, number> = {
  0x00: 0xff, 0x01: 0x7f, 0x02: 0xff, 0x03: 0x7fff, 0x04: 0xffff, 0x05: 0x7fffffff,
  0x06: 0xffffffff, 0x07: 0, 0x0a: 0, 0x0b: 0, 0x0c: 0, 0x0d: 0xff,
};

export interface FieldSpec {
  num: number;
  baseType: number;
  /** Bytes; defaults to one element of the base type. Larger = array. */
  size?: number;
}

export interface DevFieldSpec {
  num: number;
  size: number;
  devIndex: number;
}

export interface DefinitionItem {
  kind: "definition";
  local: number;
  global: number;
  fields: FieldSpec[];
  devFields?: DevFieldSpec[];
  /** Overrides `EncodeOptions.bigEndian` for this definition. */
  bigEndian?: boolean;
}

export interface DataItem {
  kind: "data";
  local: number;
  /** One raw value per defined field, in order; `null` writes the invalid value. */
  values: (number | null)[];
  /** Developer field bytes; defaults to 0xAB filling the developer size. */
  dev?: number[];
  /** Write a compressed timestamp header with this 5-bit offset (local 0-3). */
  timeOffset?: number;
}

export type FitItem = DefinitionItem | DataItem;

export interface EncodeOptions {
  bigEndian?: boolean;
  headerSize?: 12 | 14;
  /** Write a zero header CRC (allowed by the spec) instead of computing it. */
  zeroHeaderCrc?: boolean;
  corruptHeaderCrc?: boolean;
  corruptCrc?: boolean;
}

export function def(
  local: number,
  global: number,
  fields: FieldSpec[],
  extra: Partial<Omit<DefinitionItem, "kind" | "local" | "global" | "fields">> = {},
): DefinitionItem {
  return { kind: "definition", local, global, fields, ...extra };
}

export function data(
  local: number,
  values: (number | null)[],
  extra: Partial<Omit<DataItem, "kind" | "local" | "values">> = {},
): DataItem {
  return { kind: "data", local, values, ...extra };
}

export function encodeFit(items: FitItem[], opts: EncodeOptions = {}): Uint8Array {
  const body: number[] = [];
  const defs = new Map<number, DefinitionItem>();

  for (const item of items) {
    if (item.kind === "definition") {
      defs.set(item.local, item);
      const be = item.bigEndian ?? opts.bigEndian ?? false;
      body.push(0x40 | (item.devFields ? 0x20 : 0) | (item.local & 0x0f), 0, be ? 1 : 0);
      body.push(...u16(item.global, be), item.fields.length);
      for (const f of item.fields) body.push(f.num, fieldSize(f), f.baseType);
      if (item.devFields) {
        body.push(item.devFields.length);
        for (const d of item.devFields) body.push(d.num, d.size, d.devIndex);
      }
      continue;
    }
    const d = defs.get(item.local);
    if (!d) throw new Error(`encodeFit: no definition for local ${item.local}`);
    const be = d.bigEndian ?? opts.bigEndian ?? false;
    body.push(
      item.timeOffset === undefined
        ? item.local & 0x0f
        : 0x80 | ((item.local & 0x03) << 5) | (item.timeOffset & 0x1f),
    );
    d.fields.forEach((f, i) => body.push(...encodeValue(f, item.values[i] ?? null, be)));
    const devSize = (d.devFields ?? []).reduce((n, x) => n + x.size, 0);
    const dev = item.dev ?? new Array(devSize).fill(0xab);
    if (dev.length !== devSize) throw new Error("encodeFit: developer bytes do not match definition");
    body.push(...dev);
  }

  const headerSize = opts.headerSize ?? 14;
  const out = new Uint8Array(headerSize + body.length + 2);
  const view = new DataView(out.buffer);
  out[0] = headerSize;
  out[1] = 0x20; // protocol 2.0
  view.setUint16(2, 21200, true); // profile 21.200
  view.setUint32(4, body.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  if (headerSize === 14 && !opts.zeroHeaderCrc) {
    view.setUint16(12, fitCrc(out, 0, 12) ^ (opts.corruptHeaderCrc ? 0xffff : 0), true);
  }
  out.set(body, headerSize);
  const crc = fitCrc(out, 0, headerSize + body.length) ^ (opts.corruptCrc ? 0x5555 : 0);
  view.setUint16(headerSize + body.length, crc, true);
  return out;
}

/** Concatenate FIT files into one chained file. */
export function chain(...files: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(files.reduce((n, f) => n + f.length, 0));
  let pos = 0;
  for (const f of files) {
    out.set(f, pos);
    pos += f.length;
  }
  return out;
}

function fieldSize(f: FieldSpec): number {
  return f.size ?? SIZE[f.baseType & 0x1f];
}

function u16(v: number, be: boolean): number[] {
  return be ? [(v >> 8) & 0xff, v & 0xff] : [v & 0xff, (v >> 8) & 0xff];
}

function encodeValue(f: FieldSpec, value: number | null, be: boolean): number[] {
  const t = f.baseType & 0x1f;
  const elem = SIZE[t];
  const buf = new Uint8Array(fieldSize(f));
  const view = new DataView(buf.buffer);
  const invalid = INVALID[t];
  // Fill every element with the invalid value, then write the first one.
  for (let at = 0; at + elem <= buf.length; at += elem) write(view, t, at, invalid, be);
  if (value !== null) write(view, t, 0, value, be);
  return [...buf];
}

function write(view: DataView, t: number, at: number, v: number | undefined, be: boolean) {
  const le = !be;
  switch (t) {
    case 0x01:
      view.setInt8(at, v ?? 0);
      break;
    case 0x03:
      view.setInt16(at, v ?? 0, le);
      break;
    case 0x04:
    case 0x0b:
      view.setUint16(at, v ?? 0, le);
      break;
    case 0x05:
      view.setInt32(at, v ?? 0, le);
      break;
    case 0x06:
    case 0x0c:
      view.setUint32(at, v ?? 0, le);
      break;
    case 0x08:
      if (v === undefined) view.setUint32(at, 0xffffffff, le);
      else view.setFloat32(at, v, le);
      break;
    case 0x09:
      if (v === undefined) view.setFloat64(at, NaN, le);
      else view.setFloat64(at, v, le);
      break;
    case 0x0e:
    case 0x0f:
    case 0x10:
      if (v === undefined) view.setBigUint64(at, t === 0x0e ? 0x7fffffffffffffffn : t === 0x0f ? 0xffffffffffffffffn : 0n, le);
      else view.setBigUint64(at, BigInt(v), le);
      break;
    default:
      view.setUint8(at, v ?? 0);
  }
}
