import { NextResponse } from "next/server";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { isMultiUserModeEnabled } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";
import { listListings } from "@/lib/marketplace/listings";

async function requireUser(request: Request): Promise<{ userId: string } | null> {
  const settings = await getSettings();
  if (!isMultiUserModeEnabled(settings as never)) return null;
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/auth_token=([^;]+)/);
  if (!match) return null;
  const claims = await verifyUserJwt(match[1]);
  if (!claims) return null;
  return { userId: claims.sub };
}

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (!user) return NextResponse.json({ error: "Multi-user mode + auth required" }, { status: 404 });
  const listings = listListings({ ownerUserId: user.userId });
  return NextResponse.json({ listings, count: listings.length });
}
