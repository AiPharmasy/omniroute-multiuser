/**
 * marketplace/listings.ts — CRUD for pay-as-you-go provider marketplace listings.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance } from "@/lib/db/core";

type JsonRecord = Record<string, unknown>;

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}
interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

export type PricingModel = "per_token" | "per_request" | "flat";

export interface MarketplaceListing {
  id: string; slug: string; title: string; description: string | null;
  ownerUserId: string; connectionId: string | null; quotaPoolId: string | null;
  pricingModel: PricingModel;
  pricePer1kInputTokensUsd: number; pricePer1kOutputTokensUsd: number; pricePerRequestUsd: number;
  isActive: boolean; isFeatured: boolean; category: string | null; tags: string | null;
  totalRequests: number; totalTokens: number; averageRating: number | null; ratingCount: number;
  createdAt: string; updatedAt: string;
}

export interface CreateListingInput {
  slug?: string; title: string; description?: string; ownerUserId: string;
  connectionId?: string; quotaPoolId?: string; pricingModel?: PricingModel;
  pricePer1kInputTokensUsd?: number; pricePer1kOutputTokensUsd?: number; pricePerRequestUsd?: number;
  category?: string; tags?: string; isFeatured?: boolean;
}

export interface UpdateListingInput {
  title?: string; description?: string | null; pricingModel?: PricingModel;
  pricePer1kInputTokensUsd?: number; pricePer1kOutputTokensUsd?: number; pricePerRequestUsd?: number;
  isActive?: boolean; isFeatured?: boolean; category?: string | null; tags?: string | null;
}

export class ListingError extends Error {
  constructor(public code: string, message: string, public httpStatus: number = 400) {
    super(message);
    this.name = "ListingError";
  }
}

function getDb(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

export function getListingById(id: string): MarketplaceListing | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM marketplace_listings WHERE id = ?").get(id) as JsonRecord | undefined;
  return row ? rowToListing(row) : null;
}

export function getListingBySlug(slug: string): MarketplaceListing | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM marketplace_listings WHERE slug = ?").get(slug) as JsonRecord | undefined;
  return row ? rowToListing(row) : null;
}

export interface ListListingsFilter {
  ownerUserId?: string; isActive?: boolean; isFeatured?: boolean;
  category?: string; search?: string; limit?: number; offset?: number;
}

export function listListings(filter: ListListingsFilter = {}): MarketplaceListing[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.ownerUserId) { conditions.push("owner_user_id = @ownerUserId"); params.ownerUserId = filter.ownerUserId; }
  if (filter.isActive !== undefined) { conditions.push("is_active = @isActive"); params.isActive = filter.isActive ? 1 : 0; }
  if (filter.isFeatured !== undefined) { conditions.push("is_featured = @isFeatured"); params.isFeatured = filter.isFeatured ? 1 : 0; }
  if (filter.category) { conditions.push("category = @category"); params.category = filter.category; }
  if (filter.search) { conditions.push("(LOWER(title) LIKE @search OR LOWER(description) LIKE @search)"); params.search = `%${filter.search.toLowerCase()}%`; }
  let sql = "SELECT * FROM marketplace_listings";
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY is_featured DESC, created_at DESC";
  if (filter.limit !== undefined) { sql += " LIMIT @limit"; params.limit = filter.limit; }
  if (filter.offset !== undefined) { sql += " OFFSET @offset"; params.offset = filter.offset; }
  const rows = db.prepare(sql).all(params) as JsonRecord[];
  return rows.map(rowToListing);
}

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function uniqueSlug(base: string): string {
  const db = getDb();
  let candidate = base || `listing-${Date.now().toString(36)}`;
  let suffix = 0;
  while (suffix < 1000) {
    const taken = db.prepare("SELECT id FROM marketplace_listings WHERE slug = ?").get(candidate);
    if (!taken) return candidate;
    suffix++;
    candidate = `${base}-${suffix}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function createListing(input: CreateListingInput): MarketplaceListing {
  if (!input.ownerUserId) throw new ListingError("missing_owner", "ownerUserId is required");
  if (!input.title || input.title.trim().length === 0) throw new ListingError("missing_title", "title is required");
  const pricingModel: PricingModel = input.pricingModel ?? "per_token";
  if (!["per_token", "per_request", "flat"].includes(pricingModel)) throw new ListingError("invalid_pricing_model", `Unknown pricing model: ${pricingModel}`);
  if (pricingModel === "per_token") {
    if ((input.pricePer1kInputTokensUsd ?? 0) <= 0 && (input.pricePer1kOutputTokensUsd ?? 0) <= 0) {
      throw new ListingError("invalid_pricing", "per_token listings require at least one of pricePer1kInputTokensUsd or pricePer1kOutputTokensUsd > 0");
    }
  }
  if (pricingModel === "per_request" && (input.pricePerRequestUsd ?? 0) <= 0) {
    throw new ListingError("invalid_pricing", "per_request listings require pricePerRequestUsd > 0");
  }
  if (!input.connectionId && !input.quotaPoolId) throw new ListingError("missing_resource", "Either connectionId or quotaPoolId must be provided");

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const slug = uniqueSlug(input.slug ? slugify(input.slug) : slugify(input.title));

  db.prepare(
    `INSERT INTO marketplace_listings (id, slug, title, description, owner_user_id, connection_id, quota_pool_id, pricing_model, price_per_1k_input_tokens_usd, price_per_1k_output_tokens_usd, price_per_request_usd, is_active, is_featured, category, tags, total_requests, total_tokens, average_rating, rating_count, created_at, updated_at)
     VALUES (@id, @slug, @title, @description, @ownerUserId, @connectionId, @quotaPoolId, @pricingModel, @priceIn, @priceOut, @priceReq, @isActive, @isFeatured, @category, @tags, 0, 0, NULL, 0, @createdAt, @updatedAt)`
  ).run({
    id, slug, title: input.title, description: input.description ?? null, ownerUserId: input.ownerUserId,
    connectionId: input.connectionId ?? null, quotaPoolId: input.quotaPoolId ?? null, pricingModel,
    priceIn: input.pricePer1kInputTokensUsd ?? 0, priceOut: input.pricePer1kOutputTokensUsd ?? 0,
    priceReq: input.pricePerRequestUsd ?? 0, isActive: 1, isFeatured: input.isFeatured === true ? 1 : 0,
    category: input.category ?? null, tags: input.tags ?? null, createdAt: now, updatedAt: now,
  });

  const listing = getListingById(id);
  if (!listing) throw new ListingError("insert_failed", "Failed to read back created listing", 500);

  if (input.connectionId) {
    db.prepare(`UPDATE provider_connections SET is_public = 1, marketplace_listing_id = @listingId, updated_at = @updatedAt WHERE id = @connectionId`).run({ listingId: id, connectionId: input.connectionId, updatedAt: now });
  }

  return listing;
}

export function updateListing(id: string, patch: UpdateListingInput, actorUserId: string): MarketplaceListing {
  const existing = getListingById(id);
  if (!existing) throw new ListingError("not_found", `Listing ${id} not found`, 404);
  if (existing.ownerUserId !== actorUserId) throw new ListingError("forbidden", "Only the listing owner can update it", 403);

  const db = getDb();
  const sets: string[] = ["updated_at = @updatedAt"];
  const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) { sets.push("title = @title"); params.title = patch.title; }
  if (patch.description !== undefined) { sets.push("description = @description"); params.description = patch.description; }
  if (patch.pricingModel !== undefined) { sets.push("pricing_model = @pricingModel"); params.pricingModel = patch.pricingModel; }
  if (patch.pricePer1kInputTokensUsd !== undefined) { sets.push("price_per_1k_input_tokens_usd = @priceIn"); params.priceIn = patch.pricePer1kInputTokensUsd; }
  if (patch.pricePer1kOutputTokensUsd !== undefined) { sets.push("price_per_1k_output_tokens_usd = @priceOut"); params.priceOut = patch.pricePer1kOutputTokensUsd; }
  if (patch.pricePerRequestUsd !== undefined) { sets.push("price_per_request_usd = @priceReq"); params.priceReq = patch.pricePerRequestUsd; }
  if (patch.isActive !== undefined) { sets.push("is_active = @isActive"); params.isActive = patch.isActive ? 1 : 0; }
  if (patch.isFeatured !== undefined) { sets.push("is_featured = @isFeatured"); params.isFeatured = patch.isFeatured ? 1 : 0; }
  if (patch.category !== undefined) { sets.push("category = @category"); params.category = patch.category; }
  if (patch.tags !== undefined) { sets.push("tags = @tags"); params.tags = patch.tags; }

  db.prepare(`UPDATE marketplace_listings SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getListingById(id)!;
}

export function deleteListing(id: string, actorUserId: string): boolean {
  const existing = getListingById(id);
  if (!existing) return false;
  if (existing.ownerUserId !== actorUserId) throw new ListingError("forbidden", "Only the listing owner can delete it", 403);

  const db = getDb();
  if (existing.connectionId) {
    db.prepare(`UPDATE provider_connections SET is_public = 0, marketplace_listing_id = NULL, updated_at = @updatedAt WHERE id = @connectionId`).run({ connectionId: existing.connectionId, updatedAt: new Date().toISOString() });
  }
  const result = db.prepare("DELETE FROM marketplace_listings WHERE id = ?").run(id);
  return (result.changes ?? 0) > 0;
}

export function computeListingCost(listing: MarketplaceListing, usage: { inputTokens: number; outputTokens: number; requests: number }): number {
  if (listing.pricingModel === "per_request") return round6(usage.requests * listing.pricePerRequestUsd);
  if (listing.pricingModel === "per_token") {
    const inputCost = (usage.inputTokens / 1000) * listing.pricePer1kInputTokensUsd;
    const outputCost = (usage.outputTokens / 1000) * listing.pricePer1kOutputTokensUsd;
    return round6(inputCost + outputCost);
  }
  return 0;
}

export function incrementListingUsage(listingId: string, deltaRequests: number, deltaTokens: number): void {
  const db = getDb();
  db.prepare(`UPDATE marketplace_listings SET total_requests = total_requests + @deltaRequests, total_tokens = total_tokens + @deltaTokens, updated_at = @updatedAt WHERE id = @listingId`).run({ listingId, deltaRequests, deltaTokens, updatedAt: new Date().toISOString() });
}

function rowToListing(row: JsonRecord): MarketplaceListing {
  return {
    id: String(row.id), slug: String(row.slug), title: String(row.title),
    description: row.description ? String(row.description) : null, ownerUserId: String(row.owner_user_id),
    connectionId: row.connection_id ? String(row.connection_id) : null,
    quotaPoolId: row.quota_pool_id ? String(row.quota_pool_id) : null,
    pricingModel: row.pricing_model as PricingModel,
    pricePer1kInputTokensUsd: Number(row.price_per_1k_input_tokens_usd ?? 0),
    pricePer1kOutputTokensUsd: Number(row.price_per_1k_output_tokens_usd ?? 0),
    pricePerRequestUsd: Number(row.price_per_request_usd ?? 0),
    isActive: Number(row.is_active ?? 0) === 1, isFeatured: Number(row.is_featured ?? 0) === 1,
    category: row.category ? String(row.category) : null, tags: row.tags ? String(row.tags) : null,
    totalRequests: Number(row.total_requests ?? 0), totalTokens: Number(row.total_tokens ?? 0),
    averageRating: row.average_rating != null ? Number(row.average_rating) : null,
    ratingCount: Number(row.rating_count ?? 0), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
