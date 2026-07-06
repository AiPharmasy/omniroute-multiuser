import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-migration-116-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const migrationRunner = await import("../../src/lib/db/migrationRunner.ts");

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

test("migration 116 creates the users / wallets / marketplace tables", () => {
  const db = core.getDbInstance();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const names = new Set(tables.map((t) => t.name));
  for (const expected of ["users", "user_credentials", "user_sessions", "wallets", "wallet_transactions", "commission_settings", "marketplace_listings"]) {
    assert.ok(names.has(expected), `expected table ${expected} to exist`);
  }
});

test("commission_settings is seeded with the 10% default row", () => {
  const db = core.getDbInstance();
  const row = db.prepare("SELECT * FROM commission_settings WHERE id = 1").get() as any;
  assert.ok(row);
  assert.equal(row.commission_rate, 0.10);
});

test("provider_connections has owner_user_id defaulting to 'system'", () => {
  const db = core.getDbInstance();
  const cols = db.prepare("PRAGMA table_info(provider_connections)").all() as any[];
  const ownerCol = cols.find((c) => c.name === "owner_user_id");
  assert.ok(ownerCol);
  assert.equal(ownerCol.dflt_value, "'system'");
});

test("api_keys has owner_user_id defaulting to 'system'", () => {
  const db = core.getDbInstance();
  const cols = db.prepare("PRAGMA table_info(api_keys)").all() as any[];
  assert.ok(cols.find((c) => c.name === "owner_user_id"));
});

test("system & platform sentinel users + wallets backfilled", () => {
  const db = core.getDbInstance();
  assert.ok(db.prepare("SELECT * FROM users WHERE id = 'system'").get());
  assert.ok(db.prepare("SELECT * FROM users WHERE id = 'platform'").get());
  assert.ok(db.prepare("SELECT * FROM wallets WHERE id = 'wallet-system'").get());
  assert.ok(db.prepare("SELECT * FROM wallets WHERE id = 'wallet-platform'").get());
});

test("migration 116 is recorded as applied", () => {
  const db = core.getDbInstance();
  assert.ok(db.prepare("SELECT * FROM _omniroute_migrations WHERE version = '116'").get());
});

test("running migration runner again is a no-op", () => {
  const db = core.getDbInstance();
  const newlyApplied = migrationRunner.runMigrations(db);
  assert.equal(newlyApplied, 0);
});

test("wallet_transactions enforces idempotency_key uniqueness", () => {
  const db = core.getDbInstance();
  db.prepare(`INSERT INTO wallet_transactions (id, wallet_id, direction, amount, reason, reason_code, idempotency_key) VALUES ('tx1', 'wallet-system', 'credit', 5.0, 'test', 'topup', 'idem-1')`).run();
  assert.throws(() => {
    db.prepare(`INSERT INTO wallet_transactions (id, wallet_id, direction, amount, reason, reason_code, idempotency_key) VALUES ('tx2', 'wallet-system', 'credit', 5.0, 'test', 'topup', 'idem-1')`).run();
  });
});
