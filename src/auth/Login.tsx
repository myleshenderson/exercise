import { useState } from "react";
import { signInAddress } from "@starkeep/app-client/session-cookies";
import { baseUrl, isStarkeepBackend, STARKEEP_APP_ID } from "./backend";
import { loadSupabase } from "./supabase";

export default function Login() {
  return isStarkeepBackend() ? <StarkeepLogin /> : <SupabaseLogin />;
}

/**
 * Starkeep cloud: one button to the platform's sign-in page, as photos'
 * `SignInForm` does. `signInAddress` points at the platform's `/auth/start`
 * at the origin root (outside the app's mount, deliberately); the platform's
 * `/auth/callback` sets the app's session cookies and returns the browser to
 * the app root. Local Starkeep never renders this: it has no user pool, and
 * `AuthProvider` reports the person at the machine as signed in.
 */
function StarkeepLogin() {
  return (
    <div className="mx-auto max-w-sm space-y-3 p-6">
      <h1 className="text-2xl font-bold">Sign in</h1>
      <button
        type="button"
        onClick={() => window.location.assign(signInAddress(STARKEEP_APP_ID, baseUrl()))}
        className="w-full rounded-lg bg-black p-3 font-semibold text-white"
      >
        Sign in with Starkeep
      </button>
    </div>
  );
}

function SupabaseLogin() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Supabase refuses some requests (its hourly email rate limit, "Signups not
  // allowed") with `{ error }` rather than a throw; a failed chunk load or a
  // network failure throws. Either way the person stays on the form and sees why.
  async function send() {
    setSending(true);
    setError(null);
    try {
      const { error } = await (await loadSupabase()).auth.signInWithOtp({ email });
      if (error) setError(error.message);
      else setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-3 p-6">
      <h1 className="text-2xl font-bold">Sign in</h1>
      {sent ? (
        <p>Check your email for a magic link.</p>
      ) : (
        <>
          <label className="block text-sm">
            Email
            <input
              aria-label="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border p-3"
            />
          </label>
          <button
            onClick={send}
            disabled={sending}
            className="w-full rounded-lg bg-black p-3 font-semibold text-white disabled:opacity-50"
          >
            Send magic link
          </button>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              Couldn't send the link: {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
