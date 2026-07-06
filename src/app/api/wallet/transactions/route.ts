import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { listWalletTransactions } from "@/lib/billing/wallet";
import { isMultiUserModeEnabled } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";

const QuerySchema = z.object({
  limit: z.string().optional().transform((v) => (v ? Math.min(Number(v) || 50, 200) : 50)),
  offset: z.string().optional().transform((v) => (v ? Math.max(Number(v) || 0, 0) : 0)),
  direction: z.enum(["credit", "debit"]).optional(),
  reasonCode: z.enum(["topup", "consumption", "provider_payout", "commission", "refund", "withdrawal", "adjustment"]).optional(),
});

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
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) return NextResponse.json({ error: { message: "Invalid query", details: parsed.error.issues } }, { status: 400 });
  const transactions = listWalletTransactions({
    ownerUserId: user.userId, limit: parsed.data.limit, offset: parsed.data.offset,
    direction: parsed.data.direction, reasonCode: parsed.data.reasonCode,
  });
  return NextResponse.json({ transactions, count: transactions.length });
}
