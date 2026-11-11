/** Timed track points to 1 Hz channels (AI-640), shared by the GPX and TCX readers. Pure. */
import type { StreamChannel } from "../../types.js";
import type { Channels } from "../types.js";

export const EARTH_RADIUS_M = 6_371_000;

/** Longest span laid out at 1 Hz (7 days, as for FIT); later points are dropped. */
export const MAX_SPAN_S = 7 * 24 * 3600;

/** One track point; `time` is an ISO instant. Absent values are undefined or null. */
export type TrackPoint = { time: string } & Partial<Record<StreamChannel, number | null>>;

/** Great-circle distance in metres (haversine, earth radius 6 371 000 m). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cumulative haversine distance per point (null for a point without a position). */
export function cumulativeDistance(points: readonly TrackPoint[]): (number | null)[] {
  let total = 0;
  let prev: { lat: number; lng: number } | null = null;
  return points.map((p) => {
    if (typeof p.lat !== "number" || typeof p.lng !== "number") return null;
    if (prev) total += haversineM(prev.lat, prev.lng, p.lat, p.lng);
    prev = { lat: p.lat, lng: p.lng };
    return total;
  });
}

/**
 * Slot i is second i after `startedAt` (floored); the later point in a second wins; a second
 * without a point is null; points before `startedAt` are dropped; all-null channels are omitted.
 */
export function pointsToChannels(points: readonly TrackPoint[], startedAt: string): Channels {
  const t0 = Date.parse(startedAt);
  if (Number.isNaN(t0)) return {};
  const slots = new Map<number, TrackPoint>();
  let last = -1;
  for (const p of points) {
    const t = Date.parse(p.time);
    if (Number.isNaN(t)) continue;
    const s = Math.floor((t - t0) / 1000);
    if (s < 0 || s > MAX_SPAN_S) continue;
    slots.set(s, p);
    if (s > last) last = s;
  }
  const channels: Channels = {};
  if (last < 0) return channels;
  const names = new Set<StreamChannel>();
  for (const p of slots.values()) {
    for (const k of Object.keys(p) as (keyof TrackPoint)[]) {
      if (k !== "time" && typeof p[k] === "number") names.add(k as StreamChannel);
    }
  }
  for (const name of names) {
    const values: (number | null)[] = new Array(last + 1).fill(null);
    for (const [s, p] of slots) {
      const v = p[name];
      if (typeof v === "number" && Number.isFinite(v)) values[s] = v;
    }
    if (values.some((v) => v !== null)) channels[name] = values;
  }
  return channels;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML text with entities and CDATA resolved, trimmed. */
export function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e] ?? m;
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .trim();
}

/** The text of the first element with this local name (any namespace prefix) inside `xml`, or null. */
export function elementText(xml: string, localName: string): string | null {
  const re = new RegExp(`<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}\\s*>`);
  const m = re.exec(xml);
  return m ? xmlText(m[1]) : null;
}

/** `elementText` as a finite number, or null. */
export function elementNumber(xml: string, localName: string): number | null {
  const t = elementText(xml, localName);
  if (t === null || t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** An attribute value by name on a start tag, or null. */
export function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? xmlText(m[1] ?? m[2]) : null;
}
