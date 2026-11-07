import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { appPath, isStarkeepBackend } from "./backend";
import { loadSupabase } from "./supabase";

/**
 * A Starkeep session as the browser sees it. The credential itself is an
 * HttpOnly cookie the page cannot read; the app server's `GET api/session`
 * probe says whether one is live.
 */
export interface StarkeepSession {
  kind: "starkeep";
  email: string | null;
  /** Local Starkeep: no platform sign-in exists, the person at the machine is the user. */
  local: boolean;
}

export type AuthSession = Session | StarkeepSession;

interface AuthState {
  session: AuthSession | null;
  loading: boolean;
}

const Ctx = createContext<AuthState>({ session: null, loading: true });

/**
 * Ask the app server whether this browser is signed in, the way Starkeep's
 * photos app does (`AuthGate`): `GET <base>api/session` answers
 * `{ signedIn, email? }`. Anything else (a 401 from the gateway, a redirect
 * to an HTML page, a network failure) reads as signed out, and the sign-in
 * button is the retry.
 *
 * Signed out on a surface with no user pool is the local surface: local
 * Starkeep has no platform sign-in (its `api/session` can only ever answer
 * `signedIn: false`), the server binds loopback and the library has one
 * owner, so the person at the machine is the user.
 */
async function probeStarkeepSession(): Promise<StarkeepSession | null> {
  try {
    const res = await fetch(appPath("api/session"), { credentials: "same-origin" });
    if (res.ok) {
      const body = (await res.json()) as { signedIn?: boolean; email?: string };
      if (body.signedIn) return { kind: "starkeep", email: body.email ?? null, local: false };
    }
  } catch {
    // Fall through: not signed in by this probe.
  }
  return (await hasNoUserPool()) ? { kind: "starkeep", email: null, local: true } : null;
}

/**
 * Whether the app server reports no user pool in its runtime config
 * (`GET <base>starkeep-runtime-config`, public in the manifest). It fails
 * closed: an unreadable answer is treated as a cloud install, so the sign-in
 * button shows rather than the app opening without a session.
 */
async function hasNoUserPool(): Promise<boolean> {
  try {
    const res = await fetch(appPath("starkeep-runtime-config"), { credentials: "same-origin" });
    if (!res.ok) return false;
    const cfg = (await res.json()) as { userPoolId?: string } | null;
    return !!cfg && typeof cfg === "object" && !cfg.userPoolId;
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isStarkeepBackend()) {
      let cancelled = false;
      void probeStarkeepSession().then((s) => {
        if (cancelled) return;
        setSession(s);
        setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }

    // Supabase, loaded on demand so a Starkeep build never loads supabase-js.
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    loadSupabase().then((supabase) => {
      if (cancelled) return;
      supabase.auth.getSession().then(({ data }) => {
        setSession(data.session);
        setLoading(false);
      });
      const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
      unsubscribe = () => sub.subscription.unsubscribe();
    }, () => {
      // The Supabase chunk failed to load: show sign-in rather than "Loading…" forever.
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return <Ctx.Provider value={{ session, loading }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
