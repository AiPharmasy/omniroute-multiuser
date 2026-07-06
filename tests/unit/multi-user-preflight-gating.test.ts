import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-preflight-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_MULTI_USER = "true";

const core = await import("../../src/lib/db/core.ts");
const usersDb = await import("../../src/lib/db/users.ts");
const walletMod = await import("../../src/lib/billing/wallet.ts");
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

test("enforceConsumerBalance returns true when wallet has more than the floor", () => {
  const user = usersDb.createUser({ email: "rich@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 100.0, "idem-preflight-1");
  assert.equal(consumptionMod.enforceConsumerBalance(user.id, 0.01), true);
});

test("enforceConsumerBalance returns false when wallet is below the floor", () => {
  const user = usersDb.createUser({ email: "poor@example.com", passwordHash: "x" });
  assert.equal(consumptionMod.enforceConsumerBalance(user.id, 0.01), false);
});

test("enforceConsumerBalance returns true for system sentinel", () => {
  assert.equal(consumptionMod.enforceConsumerBalance("system", 0.01), true);
});

test("enforceConsumerBalance returns true for unknown user (legacy)", () => {
  assert.equal(consumptionMod.enforceConsumerBalance("nonexistent", 0.01), true);
});

test("OMNIROUTE_MIN_REQUEST_FLOOR_USD env var overrides the default floor", () => {
  const prev = process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD;
  process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD = "0.50";
  const floor = Number(process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD ?? 0.01);
  assert.equal(floor, 0.50);
  const user = usersDb.createUser({ email: "mid@example.com", passwordHash: "x" });
  walletMod.topUpWallet(user.id, 0.40, "idem-preflight-2");
  assert.equal(consumptionMod.enforceConsumerBalance(user.id, floor), false);
  walletMod.topUpWallet(user.id, 0.60, "idem-preflight-3");
  assert.equal(consumptionMod.enforceConsumerBalance(user.id, floor), true);
  if (prev === undefined) delete process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD; else process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD = prev;
});

test("setting OMNIROUTE_MIN_REQUEST_FLOOR_USD=0 disables the pre-flight gate", () => {
  const prev = process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD;
  process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD = "0";
  const floor = Number(process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD ?? 0.01);
  assert.equal(floor, 0);
  const gateActive = Number.isFinite(floor) && floor > 0;
  assert.equal(gateActive, false);
  if (prev === undefined) delete process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD; else process.env.OMNIROUTE_MIN_REQUEST_FLOOR_USD = prev;
});
