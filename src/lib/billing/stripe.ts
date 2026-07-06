/**
 * billing/stripe.ts — Stripe integration for wallet top-ups and provider payouts.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance } from "@/lib/db/core";
import { topUpWallet, applyWalletTransaction, getWalletForUser, WalletError } from "./wallet";

type JsonRecord = Record<string, unknown>;

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}
interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

function getDb(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

export function isStripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.length > 0);
}

let stripeClient: any = null;
async function getStripe(): Promise<any> {
  if (stripeClient) return stripeClient;
  if (!isStripeEnabled()) {
    throw new StripeError("not_configured", "STRIPE_SECRET_KEY is not set", 503);
  }
  const { default: Stripe } = await import("stripe");
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2024-06-20" as any,
    typescript: false,
  });
  return stripeClient;
}

export class StripeError extends Error {
  constructor(public code: string, message: string, public httpStatus: number = 400) {
    super(message);
    this.name = "StripeError";
  }
}

export interface CreateTopupInput {
  userId: string;
  amountUsd: number;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateTopupResult {
  intentId: string;
  checkoutSessionId: string;
  checkoutUrl: string;
}

export async function createCheckoutSession(input: CreateTopupInput): Promise<CreateTopupResult> {
  if (input.amountUsd < 1) throw new StripeError("invalid_amount", "Minimum top-up is $1.00");
  const stripe = await getStripe();
  const intentId = uuidv4();
  const db = getDb();

  db.prepare(`INSERT INTO stripe_topup_intents (id, user_id, amount_usd, currency, status) VALUES (@id, @userId, @amountUsd, 'usd', 'pending')`).run({ id: intentId, userId: input.userId, amountUsd: input.amountUsd });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: "OmniRoute wallet top-up", description: `Add $${input.amountUsd.toFixed(2)} to your wallet` },
        unit_amount: Math.round(input.amountUsd * 100),
      },
      quantity: 1,
    }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { omniroute_intent_id: intentId, omniroute_user_id: input.userId },
  });

  db.prepare(`UPDATE stripe_topup_intents SET stripe_checkout_session_id = ? WHERE id = ?`).run(session.id, intentId);

  return { intentId, checkoutSessionId: session.id, checkoutUrl: session.url };
}

export interface CheckoutCompletedEvent {
  stripeEventId: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  amountUsd: number;
  userId: string;
  intentId: string;
}

export async function handleCheckoutCompleted(event: CheckoutCompletedEvent): Promise<boolean> {
  const db = getDb();

  const existing = db.prepare("SELECT stripe_event_id FROM stripe_event_log WHERE stripe_event_id = ?").get(event.stripeEventId);
  if (existing) return true;

  db.prepare(`INSERT OR IGNORE INTO stripe_event_log (stripe_event_id, event_type, payload) VALUES (?, ?, ?)`).run(
    event.stripeEventId, "checkout.session.completed",
    JSON.stringify({ checkoutSessionId: event.checkoutSessionId, intentId: event.intentId })
  );

  const wallet = getWalletForUser(event.userId);
  if (!wallet) throw new StripeError("wallet_not_found", `No wallet for user ${event.userId}`, 404);

  try {
    const result = topUpWallet(
      event.userId, event.amountUsd, `stripe-topup-${event.intentId}`,
      `Stripe top-up (${event.checkoutSessionId})`,
      { stripeEventId: event.stripeEventId, paymentIntentId: event.paymentIntentId }
    );

    db.prepare(`UPDATE stripe_topup_intents SET status = 'succeeded', stripe_payment_intent_id = @paymentIntentId, wallet_transaction_id = @walletTxId, completed_at = @completedAt WHERE id = @intentId`).run({
      paymentIntentId: event.paymentIntentId ?? null,
      walletTxId: result.transaction?.id ?? null,
      completedAt: new Date().toISOString(),
      intentId: event.intentId,
    });

    return true;
  } catch (err) {
    if (err instanceof WalletError && err.code === "invalid_amount") {
      db.prepare(`UPDATE stripe_topup_intents SET status = 'failed', failure_reason = ? WHERE id = ?`).run("invalid_amount", event.intentId);
      return false;
    }
    throw err;
  }
}

export interface RequestPayoutInput {
  userId: string;
  amountUsd: number;
}

export interface RequestPayoutResult {
  payoutId: string;
  walletTransactionId: string | null;
}

export function requestPayout(input: RequestPayoutInput): RequestPayoutResult {
  if (input.amountUsd < 10) {
    throw new StripeError("below_minimum", "Minimum payout is $10.00", 400);
  }
  const db = getDb();
  const payoutId = uuidv4();
  const idempotencyKey = `payout-${payoutId}`;

  const debit = applyWalletTransaction({
    walletId: getWalletForUser(input.userId)!.id,
    direction: "debit", amount: input.amountUsd, reason: "Payout request (pending)",
    reasonCode: "withdrawal", idempotencyKey,
  });

  db.prepare(`INSERT INTO stripe_payout_requests (id, user_id, amount_usd, currency, status, wallet_transaction_id) VALUES (@id, @userId, @amountUsd, 'usd', 'pending', @walletTxId)`).run({
    id: payoutId, userId: input.userId, amountUsd: input.amountUsd,
    walletTxId: debit.transaction?.id ?? null,
  });

  return { payoutId, walletTransactionId: debit.transaction?.id ?? null };
}

export interface ApprovePayoutInput {
  payoutId: string;
  stripeConnectAccountId: string;
  operatorUserId: string;
}

export async function approvePayout(input: ApprovePayoutInput): Promise<void> {
  const db = getDb();
  const payout = db.prepare("SELECT * FROM stripe_payout_requests WHERE id = ?").get(input.payoutId) as any;
  if (!payout) throw new StripeError("not_found", "Payout request not found", 404);
  if (payout.status !== "pending") throw new StripeError("invalid_status", `Payout is already ${payout.status}`, 409);

  const stripe = await getStripe();
  const transfer = await stripe.transfers.create({
    amount: Math.round(Number(payout.amount_usd) * 100),
    currency: payout.currency || "usd",
    destination: input.stripeConnectAccountId,
    metadata: { omniroute_payout_id: payout.id, omniroute_user_id: payout.user_id, omniroute_operator: input.operatorUserId },
  });

  db.prepare(`UPDATE stripe_payout_requests SET status = 'in_transit', stripe_transfer_id = @transferId, processed_at = @processedAt WHERE id = @payoutId`).run({
    transferId: transfer.id, processedAt: new Date().toISOString(), payoutId: input.payoutId,
  });
}

export interface TopupIntent {
  id: string;
  userId: string;
  amountUsd: number;
  status: string;
  checkoutSessionId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function listTopupIntents(userId: string): TopupIntent[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM stripe_topup_intents WHERE user_id = ? ORDER BY created_at DESC").all(userId) as JsonRecord[];
  return rows.map((r) => ({
    id: String(r.id), userId: String(r.user_id), amountUsd: Number(r.amount_usd),
    status: String(r.status), checkoutSessionId: r.stripe_checkout_session_id ? String(r.stripe_checkout_session_id) : null,
    createdAt: String(r.created_at), completedAt: r.completed_at ? String(r.completed_at) : null,
  }));
}

export interface PayoutRequest {
  id: string;
  userId: string;
  amountUsd: number;
  status: string;
  stripeTransferId: string | null;
  walletTransactionId: string | null;
  requestedAt: string;
  processedAt: string | null;
}

export function listPayoutRequests(filter: { userId?: string; status?: string } = {}): PayoutRequest[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.userId) { conditions.push("user_id = @userId"); params.userId = filter.userId; }
  if (filter.status) { conditions.push("status = @status"); params.status = filter.status; }
  let sql = "SELECT * FROM stripe_payout_requests";
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY requested_at DESC";
  const rows = db.prepare(sql).all(params) as JsonRecord[];
  return rows.map((r) => ({
    id: String(r.id), userId: String(r.user_id), amountUsd: Number(r.amount_usd),
    status: String(r.status),
    stripeTransferId: r.stripe_transfer_id ? String(r.stripe_transfer_id) : null,
    walletTransactionId: r.wallet_transaction_id ? String(r.wallet_transaction_id) : null,
    requestedAt: String(r.requested_at), processedAt: r.processed_at ? String(r.processed_at) : null,
  }));
}

export function markPayoutPaid(payoutId: string, stripePayoutId: string): void {
  const db = getDb();
  db.prepare(`UPDATE stripe_payout_requests SET status = 'paid', stripe_payout_id = @payoutId, processed_at = @processedAt WHERE id = @id AND status IN ('in_transit', 'pending')`).run({ id: payoutId, payoutId: stripePayoutId, processedAt: new Date().toISOString() });
}

export function markPayoutFailed(payoutId: string, reason: string): void {
  const db = getDb();
  db.prepare(`UPDATE stripe_payout_requests SET status = 'failed', failure_reason = ?, processed_at = ? WHERE id = ?`).run(reason, new Date().toISOString(), payoutId);
}
