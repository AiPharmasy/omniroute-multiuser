import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { handleCheckoutCompleted, markPayoutPaid, markPayoutFailed, isStripeEnabled } from "@/lib/billing/stripe";

function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  return secret;
}

async function verifyStripeSignature(payload: Buffer, signature: string): Promise<any> {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2024-06-20" as any, typescript: false,
  });
  try {
    return stripe.webhooks.constructEvent(payload, signature, getStripeWebhookSecret());
  } catch (err: any) {
    throw new Error(`Stripe signature verification failed: ${err.message}`);
  }
}

export async function POST(request: Request) {
  if (!isStripeEnabled()) return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  const payload = Buffer.from(await request.arrayBuffer());
  let event: any;
  try {
    event = await verifyStripeSignature(payload, signature);
  } catch (err: any) {
    console.warn("[STRIPE WEBHOOK] signature verification failed:", err.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const intentId = session.metadata?.omniroute_intent_id;
        const userId = session.metadata?.omniroute_user_id;
        if (!intentId || !userId) {
          console.warn(`[STRIPE WEBHOOK] checkout.session.completed missing metadata — skipping (event ${event.id})`);
          break;
        }
        const amountUsd = Number(session.amount_total ?? 0) / 100;
        await handleCheckoutCompleted({
          stripeEventId: event.id, checkoutSessionId: session.id,
          paymentIntentId: session.payment_intent ?? null, amountUsd, userId, intentId,
        });
        break;
      }
      case "payout.paid": {
        const payout = event.data.object;
        const payoutRequestId = payout.metadata?.omniroute_payout_id;
        if (payoutRequestId) markPayoutPaid(payoutRequestId, payout.id);
        break;
      }
      case "payout.failed": {
        const payout = event.data.object;
        const payoutRequestId = payout.metadata?.omniroute_payout_id;
        if (payoutRequestId) markPayoutFailed(payoutRequestId, payout.failure_message || payout.failure_code || "unknown failure");
        break;
      }
      default:
        break;
    }
    return NextResponse.json({ received: true, type: event.type });
  } catch (err: any) {
    console.error("[STRIPE WEBHOOK] handler failed:", err);
    return NextResponse.json({ error: "Webhook handler failed", message: sanitizeErrorMessage(err.message) }, { status: 500 });
  }
}
