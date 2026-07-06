import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-stripe-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_MULTI_USER = "true";

const core = await import("../../src/lib/db/core.ts");
const usersDb = await import("../../src/lib/db/users.ts");
const walletMod = await import("../../src/lib/billing/wallet.ts");
const stripeMod = await import("../../src/lib/billing/stripe.ts");

function reset() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => reset());
test.after(() => {
  try { core.resetDbInstance(); } catch {}
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("migration 119 creates stripe tables", () => {
  const db = core.getDbInstance();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  const names = new Set(tables.map((t) => t.name));
  assert.ok(names.has("stripe_topup_intents"));
  assert.ok(names.has("stripe_payout_requests"));
  assert.ok(names.has("stripe_event_log"));
});

test("isStripeEnabled returns false when STRIPE_SECRET_KEY is unset", () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(stripeMod.isStripeEnabled(), false);
  if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
});

test("handleCheckoutCompleted credits the wallet via topUpWallet", async () => {
  const user = usersDb.createUser({ email: "topup@example.com", passwordHash: "x" });
  const db = core.getDbInstance();
  const intentId = "test-intent-1";
  db.prepare(`INSERT INTO stripe_topup_intents (id, user_id, amount_usd, currency, status) VALUES (?, ?, ?, 'usd', 'pending')`).run(intentId, user.id, 25.0);
  const result = await stripeMod.handleCheckoutCompleted({
    stripeEventId: "evt_test_1", checkoutSessionId: "cs_test_1",
    paymentIntentId: "pi_test_1", amountUsd: 25.0, userId: user.id, intentId,
  });
  assert.equal(result, true);
  assert.equal(walletMod.getWalletBalance(user.id), 25.0);
  const intent = db.prepare("SELECT * FROM stripe_topup_intents WHERE id = ?").get(intentId) as any;
  assert.equal(intent.status, "succeeded");
});

test("handleCheckoutCompleted is idempotent — same event id doesn't double-credit", async () => {
  const user = usersDb.createUser({ email: "topup2@example.com", passwordHash: "x" });
  const db = core.getDbInstance();
  const intentId = "test-intent-2";
  db.prepare(`INSERT INTO stripe_topup_intents (id, user_id, amount_usd, currency, status) VALUES (?, ?, ?, 'usd', 'pending')`).run(intentId, user.id, 50.0);
  await stripeMod.handleCheckoutCompleted({
    stripeEventId: "evt_test_2", checkoutSessionId: "cs_test_2",
    paymentIntentId: "pi_test_2", amountUsd: 50.0, userId: user.id, intentId,
  });
  await stripeMod.handleCheckoutCompleted({
    stripeEventId: "evt_test_2", checkoutSessionId: "cs_test_2",
    paymentIntentId: "pi_test_2", amountUsd: 50.0, userId: user.id, intentId,
  });
  assert.equal(walletMod.getWalletBalance(user.id), 50.0);
});

test("requestPayout debits the wallet and creates a 'pending' payout row", () => {
  const user = usersDb.createUser({ email: "payout@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 100.0, "idem-topup-payout-1");
  const result = stripeMod.requestPayout({ userId: user.id, amountUsd: 30.0 });
  assert.ok(result.payoutId);
  assert.equal(walletMod.getWalletBalance(user.id), 70.0);
  const payouts = stripeMod.listPayoutRequests({ userId: user.id });
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].status, "pending");
});

test("requestPayout rejects amounts below $10 minimum", () => {
  const user = usersDb.createUser({ email: "payout-min@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 100.0, "idem-topup-payout-2");
  assert.throws(() => stripeMod.requestPayout({ userId: user.id, amountUsd: 5.0 }), (err: any) => err.code === "below_minimum");
});

test("requestPayout rejects when wallet has insufficient balance", () => {
  const user = usersDb.createUser({ email: "payout-poor@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 20.0, "idem-topup-payout-3");
  assert.throws(() => stripeMod.requestPayout({ userId: user.id, amountUsd: 50.0 }), (err: any) => err.code === "insufficient_balance");
});

test("markPayoutPaid transitions a payout row to 'paid'", () => {
  const user = usersDb.createUser({ email: "payout-paid@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 100.0, "idem-topup-payout-4");
  const { payoutId } = stripeMod.requestPayout({ userId: user.id, amountUsd: 25.0 });
  stripeMod.markPayoutPaid(payoutId, "po_test_1");
  assert.equal(stripeMod.listPayoutRequests({ userId: user.id })[0].status, "paid");
});

test("markPayoutFailed transitions a payout row to 'failed' with reason", () => {
  const user = usersDb.createUser({ email: "payout-failed@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 100.0, "idem-topup-payout-5");
  const { payoutId } = stripeMod.requestPayout({ userId: user.id, amountUsd: 25.0 });
  stripeMod.markPayoutFailed(payoutId, "Bank account closed");
  assert.equal(stripeMod.listPayoutRequests({ userId: user.id })[0].status, "failed");
});

test("listTopupIntents returns intents ordered by created_at DESC", () => {
  const user = usersDb.createUser({ email: "topup-list@example.com", passwordHash: "x" });
  const db = core.getDbInstance();
  db.prepare(`INSERT INTO stripe_topup_intents (id, user_id, amount_usd, currency, status, created_at) VALUES (?, ?, ?, 'usd', 'pending', ?)`).run("older", user.id, 10.0, "2024-01-01T00:00:00Z");
  db.prepare(`INSERT INTO stripe_topup_intents (id, user_id, amount_usd, currency, status, created_at) VALUES (?, ?, ?, 'usd', 'succeeded', ?)`).run("newer", user.id, 20.0, "2024-06-01T00:00:00Z");
  const intents = stripeMod.listTopupIntents(user.id);
  assert.equal(intents.length, 2);
  assert.equal(intents[0].id, "newer");
});
