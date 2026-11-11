import { baseTypeOf } from "./baseTypes";
import { fitCrc } from "./crc";
import { FitError } from "./errors";
import {
  MESG_EVENT,
  MESG_LAP,
  MESG_RECORD,
  MESG_SESSION,
  MESG_SET,
  PROFILE,
  TEMPLATES,
  applyProfile,
} from "./profile";
import type { FitEvent, FitLap, FitMessages, FitRecord, FitSession, FitSet } from "./types";

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface Definition {
  global: number;
  littleEndian: boolean;
  fields: FieldDef[];
  /** Total bytes of developer fields, skipped. */
  devSize: number;
}

const TIMESTAMP_FIELD = 253;
const UINT32 = 0x06;

/**
 * Decode a FIT file (or several chained FIT files) into the messages this
 * module keeps: record, lap, session, event and set. Everything else is
 * skipped by size. Throws `FitError` on anything that would mis-frame.
 */
export function decodeFit(bytes: Uint8Array): FitMessages {
  const out: FitMessages = { records: [], laps: [], sessions: [], events: [], sets: [] };
  if (bytes.length === 0) throw new FitError("empty FIT file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos < bytes.length) {
    // Tolerate zero padding after the last file; anything else must be a header.
    if (bytes.subarray(pos).every((b) => b === 0)) break;
    pos = decodeOneFile(bytes, view, pos, out);
  }
  return out;
}

/** Decode the FIT file starting at `start`; return the offset after its CRC. */
function decodeOneFile(bytes: Uint8Array, view: DataView, start: number, out: FitMessages): number {
  if (bytes.length - start < 12) throw new FitError(`truncated FIT header at byte ${start}`);
  const headerSize = bytes[start];
  if (headerSize !== 12 && headerSize !== 14) {
    throw new FitError(`unsupported FIT header size ${headerSize} at byte ${start}`);
  }
  if (bytes.length - start < headerSize) throw new FitError(`truncated FIT header at byte ${start}`);
  const signature = String.fromCharCode(...bytes.subarray(start + 8, start + 12));
  if (signature !== ".FIT") throw new FitError(`missing .FIT signature at byte ${start}`);
  if (headerSize === 14) {
    const headerCrc = view.getUint16(start + 12, true);
    if (headerCrc !== 0 && headerCrc !== fitCrc(bytes, start, start + 12)) {
      throw new FitError("FIT header CRC mismatch");
    }
  }
  const dataSize = view.getUint32(start + 4, true);
  const dataStart = start + headerSize;
  const dataEnd = dataStart + dataSize;
  if (dataEnd + 2 > bytes.length) {
    throw new FitError(`FIT data size ${dataSize} runs past the end of the file`);
  }
  const fileCrc = view.getUint16(dataEnd, true);
  if (fileCrc !== fitCrc(bytes, start, dataEnd)) throw new FitError("FIT file CRC mismatch");

  const defs = new Map<number, Definition>();
  let lastTimestamp: number | null = null; // raw FIT seconds
  let pos = dataStart;

  const need = (n: number) => {
    if (pos + n > dataEnd) throw new FitError(`message at byte ${pos} runs past the data section`);
  };

  while (pos < dataEnd) {
    const header = bytes[pos++];
    if (header & 0x80) {
      // Compressed timestamp header: local type in bits 5-6, 5-bit offset.
      const local = (header >> 5) & 0x03;
      const offset = header & 0x1f;
      let timestamp: number | null = null;
      if (lastTimestamp !== null) {
        timestamp = lastTimestamp + ((offset - (lastTimestamp & 0x1f)) & 0x1f);
        lastTimestamp = timestamp;
      }
      readData(local, timestamp);
    } else if (header & 0x40) {
      const local = header & 0x0f;
      const hasDev = (header & 0x20) !== 0;
      need(5);
      const littleEndian = bytes[pos + 1] === 0;
      if (bytes[pos + 1] > 1) throw new FitError(`bad architecture byte ${bytes[pos + 1]}`);
      const global = view.getUint16(pos + 2, littleEndian);
      const nFields = bytes[pos + 4];
      pos += 5;
      need(nFields * 3);
      const fields: FieldDef[] = [];
      for (let i = 0; i < nFields; i++, pos += 3) {
        fields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: bytes[pos + 2] });
      }
      let devSize = 0;
      if (hasDev) {
        need(1);
        const nDev = bytes[pos++];
        need(nDev * 3);
        for (let i = 0; i < nDev; i++, pos += 3) devSize += bytes[pos + 1];
      }
      defs.set(local, { global, littleEndian, fields, devSize });
    } else {
      readData(header & 0x0f, null);
    }
  }
  return dataEnd + 2;

  function readData(local: number, compressedTimestamp: number | null): void {
    const def = defs.get(local);
    if (!def) throw new FitError(`data message for undefined local type ${local} at byte ${pos - 1}`);
    const profile = PROFILE[def.global];
    const values: Record<string, number | null> | null = profile ? { ...TEMPLATES[def.global] } : null;
    for (const field of def.fields) {
      need(field.size);
      const fp = profile?.[field.num];
      const isTimestamp = field.num === TIMESTAMP_FIELD;
      if (fp || isTimestamp) {
        const bt = baseTypeOf(field.baseType);
        const raw = bt && field.size >= bt.size ? bt.read(view, pos, def.littleEndian) : null;
        // Only a uint32 field 253 is the date_time that compressed headers count from.
        if (isTimestamp && raw !== null && (field.baseType & 0x1f) === UINT32) lastTimestamp = raw;
        if (fp && values) values[fp.name] = raw === null ? null : applyProfile(raw, fp);
      }
      pos += field.size;
    }
    need(def.devSize);
    pos += def.devSize;
    if (values && profile) {
      // The compressed time fills the message's timestamp (field 253, or 254 for set).
      const tsField = Object.values(profile).find((f) => f.name === "timestamp");
      if (compressedTimestamp !== null && tsField) {
        values.timestamp = applyProfile(compressedTimestamp, tsField);
      }
      keep(def.global, values);
    }
  }

  function keep(global: number, values: Record<string, number | null>) {
    switch (global) {
      case MESG_RECORD:
        out.records.push(values as unknown as FitRecord);
        break;
      case MESG_LAP:
        out.laps.push(values as unknown as FitLap);
        break;
      case MESG_SESSION:
        out.sessions.push(values as unknown as FitSession);
        break;
      case MESG_EVENT:
        out.events.push(values as unknown as FitEvent);
        break;
      case MESG_SET:
        out.sets.push(values as unknown as FitSet);
        break;
    }
  }
}
