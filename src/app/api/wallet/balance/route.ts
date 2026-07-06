import { NextResponse } from "next/server";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { getWalletForUser } from "@/lib/billing/wallet";
import { isMultiUserModeEnabled } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";

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
  if (!user) return NextResponse.json({ error: "Wallet is only available in multi-user mode" }, { status: 404 });
  const wallet = getWalletForUser(user.userId);
  if (!wallet) return NextResponse.json({ error: "Wallet not found" }, { status: 404 });
  return NextResponse.json({
    wallet: {
      id: wallet.id, ownerUserId: wallet.ownerUserId,
      balanceCredits: wallet.balanceCredits, currency: wallet.currency,
      heldCredits: wallet.heldCredits, updatedAt: wallet.updatedAt,
    },
  });
}
