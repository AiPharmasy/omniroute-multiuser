import { NextResponse } from "next/server";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { isMultiUserModeEnabled, getUserById } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";
import { getWalletForUser } from "@/lib/billing/wallet";

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
  const profile = getUserById(user.userId);
  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const wallet = getWalletForUser(user.userId);
  return NextResponse.json({
    user: {
      id: profile.id, email: profile.email, displayName: profile.displayName,
      role: profile.role, isActive: profile.isActive, isEmailVerified: profile.isEmailVerified,
      createdAt: profile.createdAt, lastLoginAt: profile.lastLoginAt,
    },
    wallet: wallet ? { id: wallet.id, balanceCredits: wallet.balanceCredits, currency: wallet.currency, updatedAt: wallet.updatedAt } : null,
  });
}
