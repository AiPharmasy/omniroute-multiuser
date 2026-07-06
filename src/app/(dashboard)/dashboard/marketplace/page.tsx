"use client";

import { useEffect, useState } from "react";

interface Listing {
  id: string; slug: string; title: string; description: string | null;
  ownerUserId: string; pricingModel: string;
  pricePer1kInputTokensUsd: number; pricePer1kOutputTokensUsd: number;
  pricePerRequestUsd: number; isActive: boolean; category: string | null;
  totalRequests: number; totalTokens: number; averageRating: number | null; ratingCount: number;
}

export default function MarketplacePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => { load(); }, [search]);

  async function load() {
    setLoading(true);
    try {
      const url = `/api/marketplace/listings?isActive=true${search ? `&search=${encodeURIComponent(search)}` : ""}&limit=100`;
      const res = await fetch(url);
      if (!res.ok) { setError("Failed to load marketplace"); return; }
      const data = await res.json(); setListings(data.listings || []);
    } catch (err) { setError(err instanceof Error ? err.message : "Network error"); }
    finally { setLoading(false); }
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui", color: "#fafafa", maxWidth: "1100px" }}>
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>Marketplace</h1>
      <p style={{ color: "#888", marginBottom: "2rem" }}>Browse pay-as-you-go providers shared by other users. Every call is metered and the platform takes a commission.</p>
      <div style={{ marginBottom: "1.5rem", display: "flex", gap: "0.75rem" }}>
        <input type="text" placeholder="Search by title or description..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, padding: "0.6rem 0.8rem", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "4px", color: "#fafafa", fontSize: "0.9rem" }} />
      </div>
      {error && <div style={{ color: "#ff8888", marginBottom: "1rem" }}>{error}</div>}
      {loading ? <div style={{ color: "#888" }}>Loading listings...</div> : listings.length === 0 ? (
        <div style={{ padding: "3rem", textAlign: "center", background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", color: "#888" }}>No listings yet. Be the first to publish a provider.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "1rem" }}>
          {listings.map((listing) => (<ListingCard key={listing.id} listing={listing} />))}
        </div>
      )}
    </div>
  );
}

function ListingCard({ listing }: { listing: Listing }) {
  const priceLabel = listing.pricingModel === "per_token" ? `$${listing.pricePer1kInputTokensUsd.toFixed(4)}/1K in · $${listing.pricePer1kOutputTokensUsd.toFixed(4)}/1K out` : listing.pricingModel === "per_request" ? `$${listing.pricePerRequestUsd.toFixed(4)}/request` : "Flat fee";
  return (
    <div style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "1.25rem" }}>
      <h3 style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>{listing.title}</h3>
      {listing.category && <span style={{ display: "inline-block", background: "#1f1f1f", color: "#888", fontSize: "0.7rem", padding: "0.15rem 0.5rem", borderRadius: "3px", marginBottom: "0.6rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{listing.category}</span>}
      {listing.description && <p style={{ color: "#888", fontSize: "0.85rem", marginBottom: "0.75rem", lineHeight: 1.5 }}>{listing.description.slice(0, 160)}{listing.description.length > 160 ? "..." : ""}</p>}
      <div style={{ color: "#3b82f6", fontSize: "0.85rem", marginBottom: "0.5rem" }}>{priceLabel}</div>
      <div style={{ color: "#555", fontSize: "0.75rem" }}>{listing.totalRequests} calls · {(listing.totalTokens / 1000).toFixed(1)}K tokens{listing.ratingCount > 0 && ` · ⭐ ${listing.averageRating?.toFixed(1)} (${listing.ratingCount})`}</div>
    </div>
  );
}
