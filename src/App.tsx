import { Routes, Route, Link } from "react-router-dom";
import Home from "./screens/Home";
import Session from "./screens/Session";
import ManageDays from "./screens/ManageDays";
import History from "./screens/History";

export default function App() {
  return (
    <div className="min-h-screen max-w-md mx-auto pb-16">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/session/:id" element={<Session />} />
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
