import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, Link, Navigate } from "react-router-dom";
import Home from "./screens/Home";
import Session from "./screens/Session";
import Summary from "./screens/Summary";
import ManageDays from "./screens/ManageDays";
import History from "./screens/History";
import LoggedWorkouts from "./screens/LoggedWorkouts";
import MCPLogin from "./screens/MCPLogin";
import ActivitiesFeed from "./rides/screens/ActivitiesFeed";
import ActivityDetail from "./rides/screens/ActivityDetail";
import MyStats from "./rides/screens/MyStats";
import Training from "./rides/screens/Training";
import PowerCurve from "./rides/screens/PowerCurve";
import Weight from "./rides/screens/Weight";
import Settings from "./rides/screens/Settings";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Login from "./auth/Login";
import { isStarkeepBackend, routerBasename } from "./auth/backend";
import { ensureSeeded } from "./data/ensureSeeded";
import { db } from "./data";

const requireAuth = (import.meta.env.VITE_DATA_BACKEND ?? "mock") === "supabase";
const supabaseConfigured =
  !!import.meta.env.VITE_SUPABASE_URL && !!import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function Shell() {
  return (
    <div className="min-h-screen max-w-md mx-auto pb-16">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/session/:id" element={<Session />} />
        <Route path="/session/:id/summary" element={<Summary />} />
        <Route path="/days" element={<ManageDays />} />
        <Route path="/history/:exerciseId" element={<History />} />
        <Route path="/workouts" element={<LoggedWorkouts />} />
        <Route path="/mcp-login" element={<MCPLogin />} />
        {/* Ride analytics (AI-627 wave 3). */}
        <Route path="/activities" element={<ActivitiesFeed />} />
        <Route path="/activities/:id" element={<ActivityDetail />} />
        <Route path="/stats" element={<MyStats />} />
        <Route path="/training" element={<Training />} />
        <Route path="/power" element={<PowerCurve />} />
        <Route path="/weight" element={<Weight />} />
        <Route path="/settings" element={<Settings />} />
        {/* The cloud redirects a signed-out browser here (Gate shows Login for
            any path then); with a session, or a backend that needs none, go home. */}
        <Route path="/sign-in" element={<Navigate to="/" replace />} />
      </Routes>
      <nav className="fixed bottom-0 inset-x-0 max-w-md mx-auto flex justify-around bg-white border-t py-2">
        <Link to="/" className="px-1 py-2 text-sm">Home</Link>
        <Link to="/days" className="px-1 py-2 text-sm">Schedule</Link>
        <Link to="/workouts" className="px-1 py-2 text-sm">Workouts</Link>
        <Link to="/activities" className="px-1 py-2 text-sm">Activities</Link>
        <Link to="/stats" className="px-1 py-2 text-sm">Stats</Link>
        <Link to="/mcp-login" className="px-1 py-2 text-sm">MCP</Link>
      </nav>
    </div>
  );
}

function Gate() {
  const { session, loading } = useAuth();
  const [seeded, setSeeded] = useState(false);
  const [seedError, setSeedError] = useState(false);
  // Seed exactly once: the auth listener fires several events (INITIAL_SESSION,
  // SIGNED_IN, …), each changing `session`. Without this guard the effect would
  // run ensureSeeded concurrently and double-seed before the first run finishes.
  const seedStarted = useRef(false);

  useEffect(() => {
    if (session && !seedStarted.current) {
      seedStarted.current = true;
      ensureSeeded(db)
        .then(() => setSeeded(true))
        .catch(() => setSeedError(true));
    }
  }, [session]);

  if (loading) return <div className="p-4">Loading…</div>;
  if (!session) return <Login />;
  if (seedError) return <div className="p-4">Couldn't finish setting up — please reload.</div>;
  if (!seeded) return <div className="p-4">Setting up…</div>;
  return <Shell />;
}

export default function App() {
  // Starkeep signs in with the platform's session (AuthProvider), and needs no
  // Supabase env.
  const starkeep = isStarkeepBackend();
  if (!requireAuth && !starkeep) return <Shell />;
  if (!starkeep && !supabaseConfigured) {
    return (
      <div className="p-6 max-w-sm mx-auto space-y-2">
        <h1 className="text-xl font-bold">Configuration error</h1>
        <p className="text-sm text-gray-600">
          The app is set to the Supabase backend but{" "}
          <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>{" "}
          are missing from this build. Set them (and redeploy, since Vite bakes env
          vars at build time).
        </p>
      </div>
    );
  }
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

/**
 * The app under a browser router mounted at Vite's `base`: `/` on Vercel and
 * local Starkeep, `/apps/exercise` in a Starkeep cloud install, where every
 * route and link must stay under the mount.
 */
export function RoutedApp() {
  return (
    <BrowserRouter basename={routerBasename()}>
      <App />
    </BrowserRouter>
  );
}
