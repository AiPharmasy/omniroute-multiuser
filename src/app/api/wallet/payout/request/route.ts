import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { z } from "zod";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { isMultiUserModeEnabled } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";
import { requestPayout, isStripeEnabled, StripeError } from "@/lib/billing/stripe";
import { WalletError } from "@/lib/billing/wallet";

const PayoutSchema = z.object({ amountUsd: z.number().min(10).max(100000) });

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

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return NextResponse.json({ error: "Multi-user mode + auth required" }, { status: 404 });
  if (!isStripeEnabled()) return NextResponse.json({ error: "Stripe is not configured. Payouts are disabled." }, { status: 503 });
  let rawBody: unknown;
  try { rawBody = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = PayoutSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: { message: "Invalid payout request", details: parsed.error.issues } }, { status: 400 });
  try {
    const result = requestPayout({ userId: user.userId, amountUsd: parsed.data.amountUsd });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof StripeError) return NextResponse.json({ error: sanitizeErrorMessage(err.message) }, { status: err.httpStatus });
    if (err instanceof WalletError) return NextResponse.json({ error: sanitizeErrorMessage(err.message) }, { status: err.httpStatus });
    console.error("[STRIPE] payout request failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
