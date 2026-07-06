"use client";

import { useEffect, useState } from "react";

interface Wallet { id: string; balanceCredits: number; currency: string; updatedAt: string; }
interface WalletTransaction { id: string; direction: "credit" | "debit"; amount: number; currency: string; reason: string; reasonCode: string; createdAt: string; }
interface TopupIntent { id: string; amountUsd: number; status: string; createdAt: string; completedAt: string | null; }
interface PayoutRequest { id: string; amountUsd: number; status: string; requestedAt: string; processedAt: string | null; }

export default function WalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [topupIntents, setTopupIntents] = useState<TopupIntent[]>([]);
  const [payouts, setPayouts] = useState<PayoutRequest[]>([]);
  const [stripeEnabled, setStripeEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [topupAmount, setTopupAmount] = useState("");
  const [payoutAmount, setPayoutAmount] = useState("");
  const [submitting, setSubmitting] = useState<"topup" | "payout" | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [balRes, txRes, topupRes, payoutRes] = await Promise.all([
        fetch("/api/wallet/balance"), fetch("/api/wallet/transactions?limit=50"),
        fetch("/api/me/topup-intents"), fetch("/api/me/payouts"),
      ]);
      if (balRes.status === 404) { setError("Wallet is only available in multi-user mode."); return; }
      if (!balRes.ok) { setError("Failed to load wallet"); return; }
      const balData = await balRes.json(); setWallet(balData.wallet);
      if (txRes.ok) { const d = await txRes.json(); setTransactions(d.transactions || []); }
      if (topupRes.ok) { const d = await topupRes.json(); setTopupIntents(d.topupIntents || []); }
      if (payoutRes.ok) { const d = await payoutRes.json(); setPayouts(d.payouts || []); }
      const probe = await fetch("/api/wallet/topup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountUsd: 0, successUrl: "x", cancelUrl: "x" }) }).catch(() => null);
      if (probe) setStripeEnabled(probe.status !== 503);
    } catch (err) { setError(err instanceof Error ? err.message : "Network error"); }
    finally { setLoading(false); }
  }

  async function handleTopup(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(topupAmount);
    if (!Number.isFinite(amount) || amount < 1) { setError("Top-up amount must be at least $1"); return; }
    setSubmitting("topup"); setError("");
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const res = await fetch("/api/wallet/topup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountUsd: amount, successUrl: `${origin}/dashboard/wallet?topup=success`, cancelUrl: `${origin}/dashboard/wallet?topup=cancel` }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Top-up failed"); return; }
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
    } catch (err) { setError(err instanceof Error ? err.message : "Network error"); }
    finally { setSubmitting(null); }
  }

  async function handlePayout(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(payoutAmount);
    if (!Number.isFinite(amount) || amount < 10) { setError("Payout amount must be at least $10"); return; }
    setSubmitting("payout"); setError("");
    try {
      const res = await fetch("/api/wallet/payout/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountUsd: amount }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Payout request failed"); return; }
      setPayoutAmount(""); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Network error"); }
    finally { setSubmitting(null); }
  }

  if (loading) return <div style={{ padding: "2rem", color: "#888", fontFamily: "system-ui" }}>Loading wallet...</div>;
  if (error && !wallet) return <div style={{ padding: "2rem", color: "#ff8888", fontFamily: "system-ui" }}>{error}</div>;

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui", color: "#fafafa", maxWidth: "1000px" }}>
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>Wallet</h1>
      <p style={{ color: "#888", marginBottom: "2rem" }}>Your credit balance, top-ups, payouts, and consumption history.</p>
      {error && <div style={{ background: "#3a1a1a", color: "#ff8888", padding: "0.75rem", borderRadius: "4px", marginBottom: "1rem", fontSize: "0.875rem" }}>{error}</div>}
      <section style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.5rem", marginBottom: "2rem" }}>
        <div style={{ fontSize: "0.85rem", color: "#888", marginBottom: "0.5rem" }}>Current balance</div>
        <div style={{ fontSize: "2.5rem", fontWeight: 600 }}>${wallet ? wallet.balanceCredits.toFixed(6) : "0.00"} <span style={{ fontSize: "1rem", color: "#888" }}>{wallet?.currency || "USD"}</span></div>
      </section>
      {stripeEnabled === false && <div style={{ background: "#2a2a1a", color: "#ddc", padding: "0.75rem", borderRadius: "4px", marginBottom: "1.5rem", fontSize: "0.85rem" }}>Stripe is not configured. Top-ups and payouts are disabled.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "2rem" }}>
        <form onSubmit={handleTopup} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.25rem" }}>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>Top up credits</h3>
          <input type="number" min="1" step="0.01" placeholder="Amount (USD)" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} disabled={stripeEnabled === false || submitting !== null} style={{ width: "100%", padding: "0.5rem", background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: "4px", color: "#fafafa", marginBottom: "0.75rem", fontSize: "0.9rem" }} />
          <button type="submit" disabled={stripeEnabled === false || submitting !== null} style={{ width: "100%", padding: "0.55rem", background: stripeEnabled === false || submitting !== null ? "#333" : "#22c55e", color: "white", border: "none", borderRadius: "4px", fontSize: "0.85rem", cursor: stripeEnabled === false || submitting !== null ? "not-allowed" : "pointer", fontWeight: 500 }}>{submitting === "topup" ? "Redirecting..." : "Add credits"}</button>
        </form>
        <form onSubmit={handlePayout} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.25rem" }}>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>Request payout</h3>
          <input type="number" min="10" step="0.01" placeholder="Amount (USD, min $10)" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} disabled={stripeEnabled === false || submitting !== null} style={{ width: "100%", padding: "0.5rem", background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: "4px", color: "#fafafa", marginBottom: "0.75rem", fontSize: "0.9rem" }} />
          <button type="submit" disabled={stripeEnabled === false || submitting !== null} style={{ width: "100%", padding: "0.55rem", background: stripeEnabled === false || submitting !== null ? "#333" : "#f59e0b", color: "white", border: "none", borderRadius: "4px", fontSize: "0.85rem", cursor: stripeEnabled === false || submitting !== null ? "not-allowed" : "pointer", fontWeight: 500 }}>{submitting === "payout" ? "Submitting..." : "Withdraw earnings"}</button>
        </form>
      </div>
      <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem" }}>Recent transactions</h2>
      {transactions.length === 0 ? <p style={{ color: "#888", marginBottom: "2rem" }}>No transactions yet.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "4px", overflow: "hidden", marginBottom: "2rem" }}>
          <thead><tr style={{ background: "#1f1f1f" }}><th style={th}>Date</th><th style={th}>Direction</th><th style={th}>Reason</th><th style={th}>Type</th><th style={th}>Amount</th></tr></thead>
          <tbody>{transactions.map((tx) => (<tr key={tx.id} style={{ borderTop: "1px solid #2a2a2a" }}><td style={td}>{new Date(tx.createdAt).toLocaleString()}</td><td style={td}><span style={{ color: tx.direction === "credit" ? "#22c55e" : "#ef4444" }}>{tx.direction}</span></td><td style={td}>{tx.reason}</td><td style={td}>{tx.reasonCode}</td><td style={td}>{tx.direction === "credit" ? "+" : "-"}${tx.amount.toFixed(6)}</td></tr>))}</tbody>
        </table>
      )}
      {topupIntents.length > 0 && (<><h2 style={{ fontSize: "1.2rem", marginBottom: "1rem", marginTop: "2rem" }}>Top-up history</h2><table style={{ width: "100%", borderCollapse: "collapse", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "4px", overflow: "hidden", marginBottom: "2rem" }}><thead><tr style={{ background: "#1f1f1f" }}><th style={th}>Date</th><th style={th}>Amount</th><th style={th}>Status</th><th style={th}>Completed</th></tr></thead><tbody>{topupIntents.map((i) => (<tr key={i.id} style={{ borderTop: "1px solid #2a2a2a" }}><td style={td}>{new Date(i.createdAt).toLocaleString()}</td><td style={td}>${i.amountUsd.toFixed(2)}</td><td style={td}><span style={{ color: i.status === "succeeded" ? "#22c55e" : i.status === "failed" ? "#ef4444" : "#f59e0b" }}>{i.status}</span></td><td style={td}>{i.completedAt ? new Date(i.completedAt).toLocaleString() : "—"}</td></tr>))}</tbody></table></>)}
      {payouts.length > 0 && (<><h2 style={{ fontSize: "1.2rem", marginBottom: "1rem", marginTop: "2rem" }}>Payout requests</h2><table style={{ width: "100%", borderCollapse: "collapse", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "4px", overflow: "hidden" }}><thead><tr style={{ background: "#1f1f1f" }}><th style={th}>Requested</th><th style={th}>Amount</th><th style={th}>Status</th><th style={th}>Processed</th></tr></thead><tbody>{payouts.map((p) => (<tr key={p.id} style={{ borderTop: "1px solid #2a2a2a" }}><td style={td}>{new Date(p.requestedAt).toLocaleString()}</td><td style={td}>${p.amountUsd.toFixed(2)}</td><td style={td}><span style={{ color: p.status === "paid" ? "#22c55e" : p.status === "failed" ? "#ef4444" : "#f59e0b" }}>{p.status}</span></td><td style={td}>{p.processedAt ? new Date(p.processedAt).toLocaleString() : "—"}</td></tr>))}</tbody></table></>)}
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.6rem 0.75rem", textAlign: "left", fontSize: "0.75rem", fontWeight: 500, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" };
const td: React.CSSProperties = { padding: "0.6rem 0.75rem", fontSize: "0.85rem", color: "#fafafa" };
