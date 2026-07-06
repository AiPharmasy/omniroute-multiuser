"use client";

import { useEffect, useState } from "react";

interface Profile {
  user: { id: string; email: string; displayName: string | null; role: string; isActive: boolean; isEmailVerified: boolean; createdAt: string; lastLoginAt: string | null; };
  wallet: { id: string; balanceCredits: number; currency: string; updatedAt: string; } | null;
}
interface ApiKeySummary { id: string; name: string; keyPrefix: string | null; isActive: boolean; scopes: string[]; createdAt: string; lastUsedAt: string | null; }
interface ProviderSummary { id: string; provider: string; name: string | null; isActive: boolean; isPublic: boolean; createdAt: string; }
interface ListingSummary { id: string; title: string; pricingModel: string; pricePer1kInputTokensUsd: number; pricePer1kOutputTokensUsd: number; pricePerRequestUsd: number; isActive: boolean; totalRequests: number; }

export default function AccountPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [listings, setListings] = useState<ListingSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [profRes, keysRes, provRes, listRes] = await Promise.all([
          fetch("/api/me"), fetch("/api/me/api-keys"), fetch("/api/me/providers"), fetch("/api/me/listings"),
        ]);
        if (profRes.status === 404) { setError("Account page is only available in multi-user mode."); return; }
        if (!profRes.ok) { setError("Failed to load account"); return; }
        setProfile(await profRes.json());
        if (keysRes.ok) { const d = await keysRes.json(); setApiKeys(d.apiKeys || []); }
        if (provRes.ok) { const d = await provRes.json(); setProviders(d.providers || []); }
        if (listRes.ok) { const d = await listRes.json(); setListings(d.listings || []); }
      } catch (err) { setError(err instanceof Error ? err.message : "Network error"); }
      finally { setLoading(false); }
    }
    load();
  }, []);

  if (loading) return <div style={{ padding: "2rem", color: "#888", fontFamily: "system-ui" }}>Loading account...</div>;
  if (error) return <div style={{ padding: "2rem", color: "#ff8888", fontFamily: "system-ui" }}>{error}</div>;
  if (!profile) return null;

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui", color: "#fafafa", maxWidth: "1100px" }}>
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>My account</h1>
      <p style={{ color: "#888", marginBottom: "2rem" }}>Welcome back, {profile.user.displayName || profile.user.email}.</p>
      <section style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.5rem", marginBottom: "2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.5rem" }}>
          <StatCard label="Wallet balance" value={`$${profile.wallet?.balanceCredits.toFixed(6) ?? "0.00"}`} sub={profile.wallet?.currency || "USD"} href="/dashboard/wallet" />
          <StatCard label="API keys" value={String(apiKeys.length)} sub={`${apiKeys.filter((k) => k.isActive).length} active`} href="/dashboard/api-manager" />
          <StatCard label="Provider connections" value={String(providers.length)} sub={`${providers.filter((p) => p.isPublic).length} published`} href="/dashboard/providers" />
        </div>
      </section>
      <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem" }}>Profile</h2>
      <section style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.5rem", marginBottom: "2rem" }}>
        <Row label="Email" value={profile.user.email} />
        <Row label="Display name" value={profile.user.displayName || "—"} />
        <Row label="Role" value={<span style={{ background: "#1f1f1f", color: profile.user.role === "admin" ? "#f59e0b" : "#3b82f6", padding: "0.15rem 0.5rem", borderRadius: "3px", fontSize: "0.75rem", textTransform: "uppercase" }}>{profile.user.role}</span>} />
        <Row label="Email verified" value={profile.user.isEmailVerified ? "Yes" : "No (pending)"} />
        <Row label="Member since" value={new Date(profile.user.createdAt).toLocaleDateString()} />
        {profile.user.lastLoginAt && <Row label="Last login" value={new Date(profile.user.lastLoginAt).toLocaleString()} />}
      </section>
      <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem" }}>My API keys</h2>
      {apiKeys.length === 0 ? <Empty msg="No API keys yet." /> : (
        <table style={tableStyle}><thead><tr style={{ background: "#1f1f1f" }}><th style={th}>Name</th><th style={th}>Prefix</th><th style={th}>Status</th><th style={th}>Scopes</th><th style={th}>Created</th><th style={th}>Last used</th></tr></thead><tbody>{apiKeys.map((k) => (<tr key={k.id} style={{ borderTop: "1px solid #2a2a2a" }}><td style={td}>{k.name}</td><td style={td}>{k.keyPrefix ? `${k.keyPrefix}...` : "—"}</td><td style={td}><span style={{ color: k.isActive ? "#22c55e" : "#666" }}>{k.isActive ? "active" : "inactive"}</span></td><td style={td}>{k.scopes.length > 0 ? k.scopes.join(", ") : "—"}</td><td style={td}>{new Date(k.createdAt).toLocaleDateString()}</td><td style={td}>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}</td></tr>))}</tbody></table>
      )}
      <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem", marginTop: "2rem" }}>My provider connections</h2>
      {providers.length === 0 ? <Empty msg="No provider connections yet." /> : (
        <table style={tableStyle}><thead><tr style={{ background: "#1f1f1f" }}><th style={th}>Provider</th><th style={th}>Name</th><th style={th}>Status</th><th style={th}>Published</th><th style={th}>Added</th></tr></thead><tbody>{providers.map((p) => (<tr key={p.id} style={{ borderTop: "1px solid #2a2a2a" }}><td style={td}>{p.provider}</td><td style={td}>{p.name || "—"}</td><td style={td}><span style={{ color: p.isActive ? "#22c55e" : "#666" }}>{p.isActive ? "active" : "inactive"}</span></td><td style={td}><span style={{ color: p.isPublic ? "#3b82f6" : "#666" }}>{p.isPublic ? "marketplace" : "private"}</span></td><td style={td}>{new Date(p.createdAt).toLocaleDateString()}</td></tr>))}</tbody></table>
      )}
      <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem", marginTop: "2rem" }}>My marketplace listings</h2>
      {listings.length === 0 ? <Empty msg="No listings yet." /> : (
        <table style={tableStyle}><thead><tr style={{ background: "#1f1f1f" }}><th style={th}>Title</th><th style={th}>Pricing</th><th style={th}>Status</th><th style={th}>Calls</th></tr></thead><tbody>{listings.map((l) => (<tr key={l.id} style={{ borderTop: "1px solid #2a2a2a" }}><td style={td}>{l.title}</td><td style={td}>{l.pricingModel === "per_token" ? `$${l.pricePer1kInputTokensUsd.toFixed(4)}/1K in · $${l.pricePer1kOutputTokensUsd.toFixed(4)}/1K out` : l.pricingModel === "per_request" ? `$${l.pricePerRequestUsd.toFixed(4)}/req` : "Flat"}</td><td style={td}><span style={{ color: l.isActive ? "#22c55e" : "#666" }}>{l.isActive ? "active" : "paused"}</span></td><td style={td}>{l.totalRequests}</td></tr>))}</tbody></table>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string; }) {
  const inner = (<div><div style={{ fontSize: "0.75rem", color: "#888", marginBottom: "0.4rem" }}>{label}</div><div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{value}</div>{sub && <div style={{ fontSize: "0.75rem", color: "#666", marginTop: "0.25rem" }}>{sub}</div>}</div>);
  if (href) return <a href={href} style={{ display: "block", padding: "1rem", background: "#0a0a0a", borderRadius: "6px", textDecoration: "none", color: "inherit", border: "1px solid #2a2a2a" }}>{inner}</a>;
  return <div style={{ padding: "1rem", background: "#0a0a0a", borderRadius: "6px" }}>{inner}</div>;
}

function Row({ label, value }: { label: string; value: React.ReactNode; }) {
  return <div style={{ display: "flex", justifyContent: "space-between", padding: "0.5rem 0", borderBottom: "1px solid #1f1f1f" }}><span style={{ color: "#888", fontSize: "0.85rem" }}>{label}</span><span style={{ fontSize: "0.85rem" }}>{value}</span></div>;
}

function Empty({ msg }: { msg: string; }) {
  return <div style={{ padding: "1.5rem", textAlign: "center", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", color: "#888", fontSize: "0.85rem", marginBottom: "2rem" }}>{msg}</div>;
}

const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "4px", overflow: "hidden" };
const th: React.CSSProperties = { padding: "0.6rem 0.75rem", textAlign: "left", fontSize: "0.75rem", fontWeight: 500, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" };
const td: React.CSSProperties = { padding: "0.6rem 0.75rem", fontSize: "0.85rem", color: "#fafafa" };
