"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName: displayName || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Registration failed"); return; }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0a", color: "#fafafa", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: "400px", padding: "2rem", background: "#161616", borderRadius: "8px", border: "1px solid #2a2a2a" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Create your account</h1>
        <p style={{ color: "#888", fontSize: "0.875rem", marginBottom: "1.5rem" }}>Sign up to share your providers on the marketplace.</p>
        {error && <div style={{ background: "#3a1a1a", color: "#ff8888", padding: "0.75rem", borderRadius: "4px", marginBottom: "1rem", fontSize: "0.875rem" }}>{error}</div>}
        <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.875rem" }}>Email</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%", padding: "0.6rem", background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: "4px", color: "#fafafa", marginBottom: "1rem", fontSize: "0.95rem" }} />
        <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.875rem" }}>Display name (optional)</label>
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={{ width: "100%", padding: "0.6rem", background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: "4px", color: "#fafafa", marginBottom: "1rem", fontSize: "0.95rem" }} />
        <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.875rem" }}>Password (min 8 chars)</label>
        <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%", padding: "0.6rem", background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: "4px", color: "#fafafa", marginBottom: "1.5rem", fontSize: "0.95rem" }} />
        <button type="submit" disabled={loading} style={{ width: "100%", padding: "0.7rem", background: loading ? "#333" : "#3b82f6", color: "white", border: "none", borderRadius: "4px", fontSize: "0.95rem", cursor: loading ? "not-allowed" : "pointer", fontWeight: 500 }}>{loading ? "Creating account..." : "Create account"}</button>
        <p style={{ marginTop: "1.5rem", fontSize: "0.8rem", color: "#666", textAlign: "center" }}>Already have an account? <a href="/login" style={{ color: "#3b82f6" }}>Sign in</a></p>
      </form>
    </main>
  );
}
