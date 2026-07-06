import { NextResponse } from "next/server";
import { z } from "zod";
import { getListingById, getListingBySlug, updateListing, deleteListing, ListingError } from "@/lib/marketplace/listings";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { SYSTEM_USER_ID } from "@/lib/db/users";

const UpdateListingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  pricingModel: z.enum(["per_token", "per_request", "flat"]).optional(),
  pricePer1kInputTokensUsd: z.number().nonnegative().optional(),
  pricePer1kOutputTokensUsd: z.number().nonnegative().optional(),
  pricePerRequestUsd: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  category: z.string().max(64).nullable().optional(),
  tags: z.string().max(500).nullable().optional(),
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

function resolveListing(idOrSlug: string) {
  return getListingById(idOrSlug) ?? getListingBySlug(idOrSlug);
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const listing = resolveListing(id);
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  return NextResponse.json({ listing });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let rawBody: unknown;
  try { rawBody = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = UpdateListingSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: { message: "Invalid update", details: parsed.error.issues } }, { status: 400 });
  const actorUserId = await getActorUserId(request);
  try {
    const listing = updateListing(id, parsed.data, actorUserId);
    return NextResponse.json({ listing });
  } catch (error) {
    if (error instanceof ListingError) return NextResponse.json({ error: error.message }, { status: error.httpStatus });
    console.error("[MARKETPLACE] update failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const actorUserId = await getActorUserId(request);
  try {
    const deleted = deleteListing(id, actorUserId);
    if (!deleted) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ListingError) return NextResponse.json({ error: error.message }, { status: error.httpStatus });
    console.error("[MARKETPLACE] delete failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
