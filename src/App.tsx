import { useEffect, useState } from "react";
import { Routes, Route, Link } from "react-router-dom";
import Home from "./screens/Home";
import Session from "./screens/Session";
import Summary from "./screens/Summary";
import ManageDays from "./screens/ManageDays";
import History from "./screens/History";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Login from "./auth/Login";
import { ensureSeeded } from "./data/ensureSeeded";
import { db } from "./data";

const requireAuth = (import.meta.env.VITE_DATA_BACKEND ?? "mock") === "supabase";

function Shell() {
  return (
    <div className="min-h-screen max-w-md mx-auto pb-16">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/session/:id" element={<Session />} />
        <Route path="/session/:id/summary" element={<Summary />} />
        <Route path="/days" element={<ManageDays />} />
        <Route path="/history/:exerciseId" element={<History />} />
      </Routes>
      <nav className="fixed bottom-0 inset-x-0 max-w-md mx-auto flex justify-around bg-white border-t py-2">
        <Link to="/" className="p-2">Home</Link>
        <Link to="/days" className="p-2">Days</Link>
      </nav>
    </div>
  );
}

function Gate() {
  const { session, loading } = useAuth();
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (session) ensureSeeded(db).then(() => setSeeded(true));
  }, [session]);

  if (loading) return <div className="p-4">Loading…</div>;
  if (!session) return <Login />;
  if (!seeded) return <div className="p-4">Setting up…</div>;
  return <Shell />;
}

export default function App() {
  if (!requireAuth) return <Shell />;
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
