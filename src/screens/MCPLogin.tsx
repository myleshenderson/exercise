import { useState } from "react";
import { getSupabase } from "../data/supabaseClient";

const TOOLS = [
  {
    name: "progression_for_exercise",
    description: "Per-session set count, top weight, and volume for an exercise (matched by partial name).",
  },
  {
    name: "sets_for_exercise",
    description: "Every individual logged set for an exercise (matched by partial name), ungrouped.",
  },
  { name: "weekly_volume", description: "Sessions and total volume per week." },
  { name: "training_gaps", description: "Days elapsed between consecutive training sessions." },
  {
    name: "get_day_templates",
    description: "Day templates with their exercises and progressive schemes (or uniform defaults).",
  },
  {
    name: "get_workout_history",
    description:
      "Full raw, unaggregated session history: every session and every logged set. Optionally filter by date range and/or exercise name.",
  },
  {
    name: "scheme_history_for_day_exercise",
    description:
      "Every recorded progressive-scheme version for a day/exercise pair, ordered by recorded_at, for point-in-time lookup.",
  },
];

function selectOnFocus(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.currentTarget.select();
}

export default function MCPLogin() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const endpointUrl = `${window.location.origin}/api/mcp`;
  const tokenPlaceholder = token ?? "YOUR_TOKEN";
  const cliSnippet = `claude mcp add --transport http exercise-mcp ${endpointUrl} --header "Authorization: Bearer ${tokenPlaceholder}"`;
  const jsonSnippet = JSON.stringify(
    {
      mcpServers: {
        "exercise-mcp": {
          type: "http",
          url: endpointUrl,
          headers: { Authorization: `Bearer ${tokenPlaceholder}` },
        },
      },
    },
    null,
    2,
  );

  async function generateToken() {
    setLoading(true);
    setError(null);
    setToken(null);
    try {
      const { data } = await getSupabase().auth.getSession();
      const session = data.session;
      if (!session) {
        setError("Your session has expired — please sign in again.");
        return;
      }
      const res = await fetch("/api/mcp-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token }),
      });
      if (!res.ok) {
        setError("Could not create a token. Please try again.");
        return;
      }
      const body = (await res.json()) as { token?: string };
      if (!body.token) {
        setError("Could not create a token. Please try again.");
        return;
      }
      setToken(body.token);
    } catch {
      setError("Could not create a token. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">MCP token</h1>
      <p className="text-sm text-gray-600">
        Generate a bearer token to paste into your MCP client config. It's shown once — if you lose
        it, generate a new one.
      </p>
      <button
        onClick={generateToken}
        disabled={loading}
        className="w-full rounded-lg bg-black p-3 font-semibold text-white disabled:opacity-50"
      >
        {loading ? "Generating…" : token ? "Generate new token" : "Generate token"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {token && (
        <div className="space-y-1">
          <label className="block text-sm" htmlFor="mcp-token">
            Your token (copy it now — it won't be shown again)
          </label>
          <input
            id="mcp-token"
            readOnly
            value={token}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border p-3 font-mono text-sm"
          />
        </div>
      )}

      <div className="space-y-4 border-t pt-4">
        <div className="space-y-1">
          <label className="block text-sm" htmlFor="mcp-endpoint">
            MCP endpoint URL
          </label>
          <input
            id="mcp-endpoint"
            readOnly
            value={endpointUrl}
            onFocus={selectOnFocus}
            className="w-full rounded-lg border p-3 font-mono text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm" htmlFor="mcp-cli-snippet">
            Claude Code CLI
          </label>
          <textarea
            id="mcp-cli-snippet"
            readOnly
            rows={2}
            value={cliSnippet}
            onFocus={selectOnFocus}
            className="w-full rounded-lg border p-3 font-mono text-xs"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm" htmlFor="mcp-json-snippet">
            mcpServers JSON
          </label>
          <textarea
            id="mcp-json-snippet"
            readOnly
            rows={9}
            value={jsonSnippet}
            onFocus={selectOnFocus}
            className="w-full rounded-lg border p-3 font-mono text-xs"
          />
        </div>

        <div className="space-y-1">
          <p className="text-sm font-semibold">Available tools</p>
          <ul className="space-y-1 text-sm text-gray-600">
            {TOOLS.map((tool) => (
              <li key={tool.name}>
                <span className="font-mono text-xs">{tool.name}</span> — {tool.description}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
