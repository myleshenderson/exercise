import { Link, useSearchParams } from "react-router-dom";
import { Placeholder } from "./Placeholder";

/** Placeholder for My Stats (AI-651 replaces it); `?tab=strength` selects the Strength tab. */
export default function MyStats() {
  const [params] = useSearchParams();
  const tab = params.get("tab") === "strength" ? "strength" : "cycling";
  return (
    <Placeholder
      title="My Stats"
      ready={`stats-${tab}`}
      header={
        <Link to="/settings" aria-label="Settings" className="p-2 text-xl text-gray-600">
          ⚙
        </Link>
      }
    />
  );
}
