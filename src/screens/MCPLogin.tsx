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
 * or null when there is no session. The session's access token goes in the
 * body; supabase-js is loaded on demand (`loadSupabase`), so a Starkeep build
 * never loads it.
 */
async function authBody(extra: Record<string, string> = {}): Promise<Record<string, string> | null> {
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
  // The backend is fixed for the life of the screen: read it once at mount.
  const [starkeep] = useState(isStarkeepBackend);
  return starkeep ? <StarkeepMcp /> : <SupabaseMcp />;
}

/** The parts of the runtime config the Starkeep screen reads. */
interface RuntimeConfig {
  connectUrl?: string;
  connectionsUrl?: string;
}

/** The platform's consent pages, as the runtime config names them. */
interface PlatformPages {
  connectUrl: string;
  connectionsUrl: string;
}

/**
 * Starkeep: the platform owns access for outside clients. In the cloud, an
 * MCP client signs in with OAuth on the platform, or the user creates a
 * delegation token on the platform's connect page and pastes it into the
 * client; the user lists and revokes both kinds on the connections page. The
 * runtime config names both pages in the cloud and neither locally. Locally,
 * `/mcp` admits any loopback caller and needs no token.
 */
function StarkeepMcp() {
  // The platform's pages in the cloud; null on the local surface, whose
  // runtime config names none; undefined while loading or when the config
  // cannot be read, so the screen claims neither surface.
  const [pages, setPages] = useState<PlatformPages | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(appPath("starkeep-runtime-config"), { credentials: "same-origin" });
        if (!res.ok) return;
        const cfg = (await res.json()) as RuntimeConfig | null;
        if (!cfg || typeof cfg !== "object") return;
        const { connectUrl, connectionsUrl } = cfg;
        const found =
          typeof connectUrl === "string" && connectUrl && typeof connectionsUrl === "string" && connectionsUrl
            ? { connectUrl, connectionsUrl }
            : null;
        if (!cancelled) setPages(found);
      } catch {
        // Unreadable: leave the screen at the endpoint and the CLI command.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const endpointUrl = `${window.location.origin}${appPath("mcp")}`;
  const cliSnippet = `claude mcp add --transport http exercise ${endpointUrl}`;
  const tokenSnippet = `claude mcp add --transport http exercise ${endpointUrl} --header "Authorization: Bearer YOUR_TOKEN"`;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Connect an MCP client</h1>
      <ReadOnlyField id="mcp-endpoint" label="MCP endpoint URL" value={endpointUrl} />
      <ReadOnlyField id="mcp-cli-snippet" label="Claude Code CLI" value={cliSnippet} rows={2} />
      {pages === undefined ? null : pages === null ? (
        <p className="text-sm text-gray-600">
          On this computer the endpoint needs no token: it answers only local programs.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Your MCP client opens a browser so you can sign in to Starkeep and approve its access.
          </p>
          <div className="space-y-1 border-t pt-4">
            <p className="text-sm font-semibold">Clients without sign-in</p>
            <p className="text-sm text-gray-600">
              <a className="underline" href={pages.connectUrl}>
                Create a token
              </a>{" "}
              for Exercise, then pass it as a header.
            </p>
            <ReadOnlyField id="mcp-token-snippet" label="Claude Code CLI with a token" value={tokenSnippet} rows={2} />
          </div>
          <p className="border-t pt-4 text-sm text-gray-600">
            <a className="underline" href={pages.connectionsUrl}>
              Manage connections
            </a>{" "}
            to see which clients can reach your data and revoke them.
          </p>
        </div>
      )}
      <div className="border-t pt-4">
        <ToolList />
      </div>
    </div>
  );
}

function ReadOnlyField({ id, label, value, rows }: { id: string; label: string; value: string; rows?: number }) {
  return (
    <div className="space-y-1">
      <label className="block text-sm" htmlFor={id}>
        {label}
      </label>
      {rows ? (
        <textarea
          id={id}
          readOnly
          rows={rows}
          value={value}
          onFocus={selectOnFocus}
          className="w-full rounded-lg border p-3 font-mono text-xs"
        />
      ) : (
        <input
          id={id}
          readOnly
          value={value}
          onFocus={selectOnFocus}
          className="w-full rounded-lg border p-3 font-mono text-sm"
        />
      )}
    </div>
  );
}

function ToolList() {
  return (
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
  );
}

/** Supabase (Vercel): Exercise mints, lists and revokes its own MCP tokens. */
function SupabaseMcp() {
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

  const endpointUrl = `${window.location.origin}/api/mcp`;
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

        <ToolList />
      </div>
    </div>
  );
}
