import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { z } from "zod";
import { createListing, listListings, ListingError } from "@/lib/marketplace/listings";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { SYSTEM_USER_ID } from "@/lib/db/users";

const BrowseQuerySchema = z.object({
  ownerUserId: z.string().max(128).optional(),
  isActive: z.string().optional().transform((v) => v === "true"),
  isFeatured: z.string().optional().transform((v) => v === "true"),
  category: z.string().max(64).optional(),
  search: z.string().max(128).optional(),
  limit: z.string().optional().transform((v) => (v ? Math.min(Number(v) || 50, 200) : 50)),
  offset: z.string().optional().transform((v) => (v ? Math.max(Number(v) || 0, 0) : 0)),
});

const CreateListingSchema = z.object({
  slug: z.string().max(80).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  connectionId: z.string().max(128).optional(),
  quotaPoolId: z.string().max(128).optional(),
  pricingModel: z.enum(["per_token", "per_request", "flat"]).default("per_token"),
  pricePer1kInputTokensUsd: z.number().nonnegative().optional(),
  pricePer1kOutputTokensUsd: z.number().nonnegative().optional(),
  pricePerRequestUsd: z.number().nonnegative().optional(),
  category: z.string().max(64).optional(),
  tags: z.string().max(500).optional(),
  isFeatured: z.boolean().optional(),
});

async function getActorUserId(request: Request): Promise<string> {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/auth_token=([^;]+)/);
  if (match) {
    const claims = await verifyUserJwt(match[1]);
    if (claims) return claims.sub;
  }
  return SYSTEM_USER_ID;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const parsed = BrowseQuerySchema.safeParse(params);
  if (!parsed.success) return NextResponse.json({ error: { message: "Invalid query", details: parsed.error.issues } }, { status: 400 });
  const listings = listListings(parsed.data);
  return NextResponse.json({ listings, count: listings.length });
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try { rawBody = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = CreateListingSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: { message: "Invalid listing data", details: parsed.error.issues } }, { status: 400 });
  const actorUserId = await getActorUserId(request);
  try {
    const listing = createListing({ ...parsed.data, ownerUserId: actorUserId });
    return NextResponse.json({ listing }, { status: 201 });
  } catch (error) {
    if (error instanceof ListingError) return NextResponse.json({ error: sanitizeErrorMessage(error.message) }, { status: error.httpStatus });
    console.error("[MARKETPLACE] create failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
