import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyUserJwt } from "@/lib/auth/userAuth";
import { isMultiUserModeEnabled } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";
import { createCheckoutSession, isStripeEnabled, StripeError } from "@/lib/billing/stripe";

const TopupSchema = z.object({
  amountUsd: z.number().min(1).max(10000),
  successUrl: z.string().url().max(500),
  cancelUrl: z.string().url().max(500),
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

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return NextResponse.json({ error: "Multi-user mode + auth required" }, { status: 404 });
  if (!isStripeEnabled()) return NextResponse.json({ error: "Stripe is not configured. Set STRIPE_SECRET_KEY to enable top-ups." }, { status: 503 });
  let rawBody: unknown;
  try { rawBody = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = TopupSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: { message: "Invalid top-up", details: parsed.error.issues } }, { status: 400 });
  try {
    const result = await createCheckoutSession({
      userId: user.userId, amountUsd: parsed.data.amountUsd,
      successUrl: parsed.data.successUrl, cancelUrl: parsed.data.cancelUrl,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof StripeError) return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    console.error("[STRIPE] topup failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
