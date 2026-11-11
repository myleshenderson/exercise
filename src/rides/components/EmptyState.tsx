import { Link } from "react-router-dom";

/** What a ride screen shows before the sync has brought anything in. */
export function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center text-sm text-gray-600">
      No rides yet. The sync fills this in; see{" "}
      <Link to="/settings" className="text-blue-700 underline">
        Settings
      </Link>
      .
    </div>
  );
}
