import { useState } from "react";
import { getSupabase } from "../data/supabaseClient";

export default function MCPLogin() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    </div>
  );
}
