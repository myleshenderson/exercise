import type { ReactNode } from "react";
import { EmptyState } from "../components/EmptyState";

/**
 * Shared shell of A's placeholder screens (AI-649): a heading and the empty state, with
 * `data-ready` set at once (`null` leaves it off until the screen has loaded). B, C and D replace the screens that use it.
 */
export function Placeholder({ title, ready, header }: { title: string; ready: string | null; header?: ReactNode }) {
  return (
    <div className="space-y-3 p-4" data-ready={ready ?? undefined}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{title}</h1>
        {header}
      </div>
      <EmptyState />
    </div>
  );
}
