import { useEffect, useState } from "react";
import { appPath, isStarkeepBackend } from "../auth/backend";
import { loadSupabase } from "../auth/supabase";

interface McpSession {
  id: string;
  createdAt: string;
  lastUsedAt: string;
}

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
  {
    name: "adherence_for_day",
    description:
      "Actual logged sets vs. the prescribed target in effect on each session's date, flagging under-/over-shooting on sets, reps, and weight. Optionally filter by day and/or date range.",
  },
  {
    name: "update_exercise",
    description: "Partially updates a catalog exercise's name, cue, and/or defaults, targeted by id.",
  },
  {
    name: "list_exercises",
    description: "Every catalog exercise, including ones not attached to any day.",
  },
  {
    name: "delete_exercise",
    description:
      "Soft-deletes a catalog exercise by id. Rejected if it's still attached to any day or referenced by logged sets/scheme history.",
  },
];

/**
 * The JSON body that authenticates a call to `api/mcp-login` / `api/mcp-sessions`,
 * or null when there is no session.
 *
 * Supabase: the session's access token goes in the body; supabase-js is
 * loaded on demand (`loadSupabase`), so a Starkeep build never loads it.
 * Starkeep: the app server reads the platform session from its HttpOnly
 * cookie, which a same-origin fetch sends by itself; the body carries no
 * credential.
 */
async function authBody(extra: Record<string, string> = {}): Promise<Record<string, string> | null> {
  if (isStarkeepBackend()) return { ...extra };
  const { data } = await (await loadSupabase()).auth.getSession();
  const session = data?.session;
  if (!session) return null;
  return { access_token: session.access_token, ...extra };
}

const SESSION_EXPIRED = "Your session has expired — please sign in again.";

function selectOnFocus(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.currentTarget.select();
}

export default function MCPLogin() {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<McpSession[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [sessionsVersion, setSessionsVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await authBody();
        if (!body) return;
        const res = await fetch(appPath("api/mcp-sessions"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const list = (await res.json()) as { sessions?: McpSession[] };
        if (!cancelled) setSessions(list.sessions ?? []);
      } catch {
        // Best-effort: the session list is a convenience, not the critical path.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionsVersion]);

  async function revokeSession(id: string) {
    setRevokingId(id);
    setSessionsError(null);
    try {
      const body = await authBody({ session_id: id });
      if (!body) {
        setSessionsError(SESSION_EXPIRED);
        return;
      }
      const res = await fetch(appPath("api/mcp-sessions"), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (isStarkeepBackend() && res.status === 401) {
          setSessionsError(SESSION_EXPIRED);
          return;
        }
        setSessionsError("Could not revoke that session. Please try again.");
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      setSessionsError("Could not revoke that session. Please try again.");
    } finally {
      setRevokingId(null);
    }
  }

  // Starkeep serves MCP at the app's own `mcp` route (under `/apps/exercise/`
  // in the cloud); Vercel at `/api/mcp`.
  const endpointUrl = isStarkeepBackend()
    ? `${window.location.origin}${appPath("mcp")}`
    : `${window.location.origin}/api/mcp`;
  const tokenPlaceholder = token ?? "YOUR_TOKEN";
  const cliSnippet = `claude mcp add --transport http exercise-mcp ${endpointUrl} --header "Authorization: Bearer ${tokenPlaceholder}"`;
  const jsonSnippet = JSON.stringify(
    {
      mcpServers: {
        "exercise-mcp": {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            endpointUrl,
            "--transport",
            "http-only",
            "--header",
            "Authorization: Bearer ${EXERCISE_MCP_TOKEN}",
          ],
          env: { EXERCISE_MCP_TOKEN: tokenPlaceholder },
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
    setExpiresAt(null);
    try {
      const auth = await authBody();
      if (!auth) {
        setError(SESSION_EXPIRED);
        return;
      }
      const res = await fetch(appPath("api/mcp-login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(auth),
      });
      if (!res.ok) {
        // Starkeep authenticates by cookie, so an expired session shows up here.
        if (isStarkeepBackend() && res.status === 401) {
          setError(SESSION_EXPIRED);
          return;
        }
        setError("Could not create a token. Please try again.");
        return;
      }
      const body = (await res.json()) as { token?: string; expires_at?: string };
      if (!body.token) {
        setError("Could not create a token. Please try again.");
        return;
      }
      setToken(body.token);
      setExpiresAt(body.expires_at ?? null);
      setSessionsVersion((v) => v + 1);
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
          {expiresAt && (
            <p className="text-sm text-gray-600">Expires {new Date(expiresAt).toLocaleString()}</p>
          )}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-semibold">Active sessions</p>
          <p className="text-sm text-gray-600">
            Revoke a session to immediately stop the MCP client using its token from working.
          </p>
          {sessionsError && <p className="text-sm text-red-600">{sessionsError}</p>}
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-600">
                  Created {new Date(s.createdAt).toLocaleString()} · last used{" "}
                  {new Date(s.lastUsedAt).toLocaleString()}
                </span>
                <button
                  onClick={() => revokeSession(s.id)}
                  disabled={revokingId === s.id}
                  className="shrink-0 rounded border border-red-600 px-2 py-1 text-red-600 disabled:opacity-50"
                >
                  {revokingId === s.id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
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
