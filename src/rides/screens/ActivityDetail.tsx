import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useRideDb } from "../RideDb";
import { Placeholder } from "./Placeholder";

/**
 * Placeholder for Activity detail (AI-650 replaces it). Sets `data-ready` to `activity-outdoor` or
 * `activity-indoor` once the row has loaded (`activity` when there is none), as the real screen will.
 */
export default function ActivityDetail() {
  const { id = "" } = useParams();
  const db = useRideDb();
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    db.getExternalActivity(id).then(
      (a) => !cancelled && setReady(a ? `activity-${a.environment}` : "activity"),
      () => !cancelled && setReady("activity"),
    );
    return () => {
      cancelled = true;
    };
  }, [db, id]);
  return <Placeholder title="Activity" ready={ready} />;
}
