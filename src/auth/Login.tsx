import { useState } from "react";
import { getSupabase } from "../data/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  async function send() {
    await getSupabase().auth.signInWithOtp({ email });
    setSent(true);
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
          <button onClick={send} className="w-full rounded-lg bg-black p-3 font-semibold text-white">
            Send magic link
          </button>
        </>
      )}
    </div>
  );
}
