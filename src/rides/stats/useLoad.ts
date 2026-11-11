import { useEffect, useState } from "react";

export type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** Runs `load` (memoise it with `useCallback`) on mount and whenever it changes; late results of a stale call are dropped. */
export function useLoad<T>(load: () => Promise<T>): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load().then(
      (data) => !cancelled && setState({ status: "ready", data }),
      (e: unknown) => !cancelled && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [load]);
  return state;
}
