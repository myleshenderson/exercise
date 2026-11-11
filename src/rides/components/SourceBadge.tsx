import type { ActivitySource } from "../../types";

export type BadgeSource = ActivitySource | "strength";

const BADGES: Record<BadgeSource, { label: string; className: string }> = {
  garmin: { label: "Garmin", className: "bg-sky-50 text-sky-800 border-sky-200" },
  peloton: { label: "Peloton", className: "bg-rose-50 text-rose-800 border-rose-200" },
  strava_export: { label: "Strava", className: "bg-orange-50 text-orange-800 border-orange-200" },
  strength: { label: "Strength", className: "bg-gray-50 text-gray-800 border-gray-300" },
};

/** Small pill naming where a row came from: Garmin, Peloton, Strava or Strength. */
export function SourceBadge({ source }: { source: BadgeSource }) {
  const b = BADGES[source];
  return (
    <span data-source={source} className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${b.className}`}>
      {b.label}
    </span>
  );
}
