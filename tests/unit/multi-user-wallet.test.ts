import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-wallet-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const usersDb = await import("../../src/lib/db/users.ts");
const walletMod = await import("../../src/lib/billing/wallet.ts");
const commissionMod = await import("../../src/lib/billing/commission.ts");
const consumptionMod = await import("../../src/lib/billing/consumption.ts");

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

test("createUser implicitly creates a wallet with 0 balance", () => {
  const user = usersDb.createUser({ email: "u1@example.com", passwordHash: "x" });
  const wallet = walletMod.getWalletForUser(user.id);
  assert.ok(wallet);
  assert.equal(wallet.balanceCredits, 0);
});

test("topUpWallet credits the wallet and returns a transaction row", () => {
  const user = usersDb.createUser({ email: "u2@example.com", passwordHash: "x" });
  const result = walletMod.topUpWallet(user.id, 50.0, "idem-topup-1");
  assert.equal(result.replayed, false);
  assert.ok(result.transaction);
  assert.equal(result.transaction.direction, "credit");
  assert.equal(result.wallet.balanceCredits, 50.0);
});

test("topUpWallet is idempotent", () => {
  const user = usersDb.createUser({ email: "u3@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 30.0, "idem-topup-2");
  const second = walletMod.topUpWallet(user.id, 30.0, "idem-topup-2");
  assert.equal(second.replayed, true);
  assert.equal(second.wallet.balanceCredits, 30.0);
});

test("debitConsumer succeeds when balance is sufficient", () => {
  const user = usersDb.createUser({ email: "u4@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 100.0, "idem-topup-3");
  const result = walletMod.debitConsumer(user.id, 25.0, "idem-debit-1");
  assert.equal(result.wallet.balanceCredits, 75.0);
});

test("debitConsumer rejects with insufficient_balance when balance too low", () => {
  const user = usersDb.createUser({ email: "u5@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 10.0, "idem-topup-4");
  assert.throws(() => walletMod.debitConsumer(user.id, 50.0, "idem-debit-2"), (err: unknown) => (err as { code?: string }).code === "insufficient_balance" && err.httpStatus === 402);
  assert.equal(walletMod.getWalletBalance(user.id), 10.0);
});

test("creditProvider + creditPlatformCommission split a consumer cost correctly", () => {
  const consumer = usersDb.createUser({ email: "consumer@example.com", passwordHash: "x" });
  const provider = usersDb.createUser({ email: "provider@example.com", passwordHash: "x" });
  walletMod.topUpWallet(consumer.id, 100.0, "idem-topup-5");
  const split = commissionMod.splitCost(10.0);
  assert.equal(split.totalCost, 10.0);
  assert.equal(split.commissionAmount, 1.0);
  assert.equal(split.providerPayout, 9.0);
  const debit = walletMod.debitConsumer(consumer.id, split.totalCost, "idem-debit-3");
  assert.equal(debit.wallet.balanceCredits, 90.0);
  const providerCredit = walletMod.creditProvider(provider.id, split.providerPayout, debit.wallet.id, "idem-credit-1");
  assert.equal(providerCredit.wallet.balanceCredits, 9.0);
  const platformCredit = walletMod.creditPlatformCommission(split.commissionAmount, debit.wallet.id, "idem-credit-2");
  assert.ok(platformCredit.wallet.id === "wallet-platform");
  assert.ok(platformCredit.wallet.balanceCredits >= 1.0);
});

test("splitCost handles zero cost", () => {
  const split = commissionMod.splitCost(0);
  assert.equal(split.totalCost, 0);
  assert.equal(split.commissionAmount, 0);
  assert.equal(split.providerPayout, 0);
});

test("splitCost handles fractional costs without rounding loss", () => {
  const split = commissionMod.splitCost(0.001, 0.10);
  assert.equal(split.commissionAmount, 0.0001);
  assert.equal(split.providerPayout, 0.0009);
  assert.equal(split.commissionAmount + split.providerPayout, split.totalCost);
});

test("getCommissionSettings returns the seeded 10% default", () => {
  assert.equal(commissionMod.getCommissionSettings().rate, 0.10);
});

test("updateCommissionRate persists the new rate", () => {
  assert.equal(commissionMod.updateCommissionRate(0.15, "admin").rate, 0.15);
  assert.equal(commissionMod.getCommissionSettings().rate, 0.15);
});

test("updateCommissionRate rejects out-of-range rates", () => {
  assert.throws(() => commissionMod.updateCommissionRate(-0.1, "x"));
  assert.throws(() => commissionMod.updateCommissionRate(1.5, "x"));
});

test("recordConsumption debits consumer, credits provider, credits platform commission", () => {
  const consumer = usersDb.createUser({ email: "c@example.com", passwordHash: "x" });
  const provider = usersDb.createUser({ email: "p@example.com", passwordHash: "x" });
  walletMod.topUpWallet(consumer.id, 100.0, "idem-topup-6");
  const result = consumptionMod.recordConsumption({ consumerUserId: consumer.id, providerOwnerUserId: provider.id, totalCostUsd: 10.0, usageHistoryId: 1 });
  assert.equal(result.insufficientBalance, false);
  assert.equal(result.split.commissionAmount, 1.0);
  assert.equal(result.split.providerPayout, 9.0);
  assert.equal(walletMod.getWalletBalance(consumer.id), 90.0);
  assert.equal(walletMod.getWalletBalance(provider.id), 9.0);
  assert.equal(walletMod.getWalletBalance("platform"), 1.0);
});

test("recordConsumption is idempotent — same usageHistoryId never double-charges", () => {
  const consumer = usersDb.createUser({ email: "c2@example.com", passwordHash: "x" });
  const provider = usersDb.createUser({ email: "p2@example.com", passwordHash: "x" });
  walletMod.topUpWallet(consumer.id, 100.0, "idem-topup-7");
  consumptionMod.recordConsumption({ consumerUserId: consumer.id, providerOwnerUserId: provider.id, totalCostUsd: 10.0, usageHistoryId: 2 });
  const r2 = consumptionMod.recordConsumption({ consumerUserId: consumer.id, providerOwnerUserId: provider.id, totalCostUsd: 10.0, usageHistoryId: 2 });
  assert.equal(r2.debit.replayed, true);
  assert.equal(r2.providerCredit?.replayed, true);
  assert.equal(walletMod.getWalletBalance(consumer.id), 90.0);
  assert.equal(walletMod.getWalletBalance(provider.id), 9.0);
});

test("recordConsumption with self-consumption settles nothing", () => {
  const user = usersDb.createUser({ email: "self@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 100.0, "idem-topup-8");
  const result = consumptionMod.recordConsumption({ consumerUserId: user.id, providerOwnerUserId: user.id, totalCostUsd: 10.0, usageHistoryId: 3 });
  assert.equal(result.providerCredit, null);
  assert.equal(walletMod.getWalletBalance(user.id), 100.0);
});

test("recordConsumption with system-owned provider credits full amount to platform", () => {
  const consumer = usersDb.createUser({ email: "c3@example.com", passwordHash: "x" });
  walletMod.topUpWallet(consumer.id, 100.0, "idem-topup-9");
  consumptionMod.recordConsumption({ consumerUserId: consumer.id, providerOwnerUserId: "system", totalCostUsd: 10.0, usageHistoryId: 4 });
  assert.equal(walletMod.getWalletBalance(consumer.id), 90.0);
  assert.equal(walletMod.getWalletBalance("platform"), 10.0);
});

test("enforceConsumerBalance returns true when balance covers estimated cost", () => {
  const consumer = usersDb.createUser({ email: "c5@example.com", passwordHash: "x" });
  walletMod.topUpWallet(consumer.id, 50.0, "idem-topup-10");
  assert.equal(consumptionMod.enforceConsumerBalance(consumer.id, 10.0), true);
  assert.equal(consumptionMod.enforceConsumerBalance(consumer.id, 50.01), false);
});

test("enforceConsumerBalance returns true for system user", () => {
  assert.equal(consumptionMod.enforceConsumerBalance("system", 1000.0), true);
});
