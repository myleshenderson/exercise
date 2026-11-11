import type { ReactNode } from "react";

/** A label, a value and an optional sub-line ("incl. 312.4 mi indoor"). */
export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="whitespace-nowrap text-lg font-semibold leading-tight text-gray-900">{value}</div>
      {sub !== undefined && sub !== null && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}
