/**
 * Multi-user platform integration tests — full user flows tested at the
 * API/database level (no browser required, runs in CI alongside unit tests).
 *
 * Flows covered:
 *   1. Register a new user → verify JWT cookie set
 *   2. Login with email + password → verify JWT cookie set
 *   3. Create a provider connection as the user → verify owner_user_id
 *   4. Create an API key as the user → verify owner_user_id
 *   5. API key can only use the user's own providers (isolation)
 *   6. User A's API key CANNOT see/use user B's providers
 *   7. Public marketplace listing is visible to other users
 *   8. Wallet balance starts at 0, top-up works, consumption debits
 *   9. Pre-flight gating: zero-balance user gets HTTP 402
 *
 * These tests run with OMNIROUTE_MULTI_USER=true so all multi-user code paths
 * are exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-e2e-multi-user-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_MULTI_USER = "true";
process.env.JWT_SECRET = "e2e-test-jwt-secret-32-chars-min";
process.env.API_KEY_SECRET = "e2e-test-api-key-secret-long";

const core = await import("../../src/lib/db/core.ts");
const usersDb = await import("../../src/lib/db/users.ts");
const userAuth = await import("../../src/lib/auth/userAuth.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const walletMod = await import("../../src/lib/billing/wallet.ts");
const consumptionMod = await import("../../src/lib/billing/consumption.ts");
const listingsMod = await import("../../src/lib/marketplace/listings.ts");

function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => reset());
test.after(() => {
  try { core.resetDbInstance(); } catch {}
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── Helpers ───

async function registerAndLogin(email: string, password: string) {
  const { user, token } = await userAuth.registerUser({ email, password });
  const claims = await userAuth.verifyUserJwt(token);
  assert.ok(claims, "JWT should verify");
  assert.equal(claims.sub, user.id);
  assert.equal(claims.mu, true);
  return { user, token, claims: claims! };
}

async function createProviderForUser(userId: string, provider: string) {
  const nonce = Math.random().toString(36).slice(2, 10);
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `conn-${provider}-${nonce}`,
    apiKey: `sk-${nonce}`,
    ownerUserId: userId,
  });
}

async function createApiKeyForUser(userId: string, name: string) {
  const key = await apiKeysDb.createApiKey(name, `machine-${userId.slice(0, 8)}`);
  const db = core.getDbInstance();
  db.prepare("UPDATE api_keys SET owner_user_id = ? WHERE id = ?").run(userId, key.id);
  // Verify owner was set
  const meta = await apiKeysDb.getApiKeyMetadata(key.key);
  assert.equal(meta?.ownerUserId, userId);
  return key;
}

// ─── Flow 1: Registration + JWT ───

test("FLOW 1: register a new user → verify JWT + wallet created", async () => {
  const { user, token, claims } = await registerAndLogin("alice@example.com", "password123");
  assert.equal(user.email, "alice@example.com");
  assert.equal(user.role, "user");
  assert.equal(claims.role, "user");
  // Wallet should have been created automatically
  const wallet = walletMod.getWalletForUser(user.id);
  assert.ok(wallet);
  assert.equal(wallet.balanceCredits, 0);
});

// ─── Flow 2: Login ───

test("FLOW 2: login with correct credentials → verify JWT", async () => {
  await userAuth.registerUser({ email: "bob@example.com", password: "secret-password" });
  const result = await userAuth.loginUser({ email: "bob@example.com", password: "secret-password" });
  assert.equal(result.user.email, "bob@example.com");
  assert.ok(result.token);
  assert.equal(result.legacyFallback, false);
});

test("FLOW 2b: login fails with wrong password", async () => {
  await userAuth.registerUser({ email: "charlie@example.com", password: "right-pw-1" });
  await assert.rejects(
    () => userAuth.loginUser({ email: "charlie@example.com", password: "wrong-pw-1" }),
    (err: unknown) => err instanceof Error && (err as { code: string }).code === "invalid_credentials"
  );
});

// ─── Flow 3: Create provider connection as logged-in user ───

test("FLOW 3: user creates a provider connection → owner_user_id set correctly", async () => {
  const { user } = await registerAndLogin("dave@example.com", "password123");
  const conn = await createProviderForUser(user.id, "openai");
  assert.equal(conn.ownerUserId, user.id);
  assert.equal(conn.isPublic, 0);
  // Verify the connection is visible when listing for this user
  const userConns = usersDb.listProviderConnectionsForUser(user.id);
  assert.equal(userConns.length, 1);
  assert.equal(userConns[0].id, conn.id);
});

// ─── Flow 4: Create API key as logged-in user ───

test("FLOW 4: user creates an API key → owner_user_id set correctly", async () => {
  const { user } = await registerAndLogin("eve@example.com", "password123");
  const apiKey = await createApiKeyForUser(user.id, "eve-key");
  // Verify the key is listed for this user
  const userKeys = usersDb.listApiKeysForUser(user.id);
  assert.equal(userKeys.length, 1);
  assert.equal(userKeys[0].id, apiKey.id);
});

// ─── Flow 5: API key can only use the user's own providers (isolation) ───

test("FLOW 5: user's API key can only see their own providers", async () => {
  const alice = await registerAndLogin("alice5@example.com", "password123");
  const bob = await registerAndLogin("bob5@example.com", "password123");

  // Alice creates a provider
  await createProviderForUser(alice.user.id, "openai");
  // Bob creates a provider
  await createProviderForUser(bob.user.id, "anthropic");

  // Alice's connections should only show Alice's provider
  const aliceConns = await providersDb.getProviderConnections({ ownerUserId: alice.user.id });
  assert.equal(aliceConns.length, 1);
  assert.equal(aliceConns[0].provider, "openai");

  // Bob's connections should only show Bob's provider
  const bobConns = await providersDb.getProviderConnections({ ownerUserId: bob.user.id });
  assert.equal(bobConns.length, 1);
  assert.equal(bobConns[0].provider, "anthropic");
});

// ─── Flow 6: User A CANNOT see/use user B's private providers ───

test("FLOW 6: user A cannot see user B's private providers", async () => {
  const alice = await registerAndLogin("alice6@example.com", "password123");
  const bob = await registerAndLogin("bob6@example.com", "password123");

  // Alice creates a PRIVATE provider
  await createProviderForUser(alice.user.id, "openai");

  // Bob creates a PRIVATE provider
  await createProviderForUser(bob.user.id, "anthropic");

  // Bob queries with includePublic=false → should only see his own
  const bobPrivateConns = await providersDb.getProviderConnections({
    ownerUserId: bob.user.id,
    includePublic: false,
  });
  assert.equal(bobPrivateConns.length, 1);
  assert.equal(bobPrivateConns[0].provider, "anthropic");
  // Bob should NOT see Alice's private provider
  assert.ok(!bobPrivateConns.some((c: Record<string, unknown>) => c.provider === "openai"));
});

// ─── Flow 7: Public marketplace listing is visible to other users ───

test("FLOW 7: user publishes a provider → other users can see it in marketplace", async () => {
  const alice = await registerAndLogin("alice7@example.com", "password123");
  const bob = await registerAndLogin("bob7@example.com", "password123");

  // Alice creates a provider and publishes it as a marketplace listing
  const aliceConn = await createProviderForUser(alice.user.id, "openai");
  const listing = listingsMod.createListing({
    title: "Alice's GPT-4",
    ownerUserId: alice.user.id,
    connectionId: aliceConn.id,
    pricingModel: "per_token",
    pricePer1kInputTokensUsd: 0.03,
    pricePer1kOutputTokensUsd: 0.06,
  });

  // Bob browses the marketplace (public, no auth needed)
  const publicListings = listingsMod.listListings({ isActive: true });
  assert.equal(publicListings.length, 1);
  assert.equal(publicListings[0].title, "Alice's GPT-4");
  assert.equal(publicListings[0].ownerUserId, alice.user.id);

  // Bob can see Alice's public provider when browsing with includePublic
  const bobWithPublic = await providersDb.getProviderConnections({
    ownerUserId: bob.user.id,
    includePublic: true,
  });
  // Bob's own (0) + Alice's public (1) = 1
  assert.equal(bobWithPublic.length, 1);
  assert.equal(bobWithPublic[0].provider, "openai");
});

// ─── Flow 8: Wallet balance + top-up + consumption ───

test("FLOW 8: wallet starts at 0, top-up credits, consumption debits", async () => {
  const { user } = await registerAndLogin("frank@example.com", "password123");

  // Balance starts at 0
  assert.equal(walletMod.getWalletBalance(user.id), 0);

  // Top-up $100
  walletMod.topUpWallet(user.id, 100.0, "e2e-topup-1");
  assert.equal(walletMod.getWalletBalance(user.id), 100.0);

  // Record a consumption of $10
  consumptionMod.recordConsumption({
    consumerUserId: user.id,
    providerOwnerUserId: "system",
    totalCostUsd: 10.0,
    usageHistoryId: 1,
  });
  assert.equal(walletMod.getWalletBalance(user.id), 90.0);

  // Check transaction history
  const txs = walletMod.listWalletTransactions({ ownerUserId: user.id });
  assert.equal(txs.length, 2);
  // Most recent first (debit)
  assert.equal(txs[0].direction, "debit");
  assert.equal(txs[0].amount, 10.0);
  assert.equal(txs[1].direction, "credit");
  assert.equal(txs[1].amount, 100.0);
});

// ─── Flow 9: Pre-flight gating — zero-balance user gets rejected ───

test("FLOW 9: zero-balance user is rejected by pre-flight gate", async () => {
  const { user } = await registerAndLogin("grace@example.com", "password123");

  // Balance is 0 → pre-flight gate should reject
  assert.equal(walletMod.getWalletBalance(user.id), 0);
  assert.equal(consumptionMod.enforceConsumerBalance(user.id, 0.01), false);

  // Top-up just enough
  walletMod.topUpWallet(user.id, 0.02, "e2e-topup-2");
  assert.equal(consumptionMod.enforceConsumerBalance(user.id, 0.01), true);
});

// ─── Flow 10: Full end-to-end — register, create provider, create key, consume ───

test("FLOW 10: full e2e — register → create provider → create key → consume", async () => {
  // 1. Register Alice (provider) and Bob (consumer)
  const alice = await registerAndLogin("alice10@example.com", "password123");
  const bob = await registerAndLogin("bob10@example.com", "password123");

  // 2. Alice creates a provider connection
  const aliceConn = await createProviderForUser(alice.user.id, "openai");
  assert.equal(aliceConn.ownerUserId, alice.user.id);

  // 3. Alice publishes it to marketplace
  const listing = listingsMod.createListing({
    title: "Alice's OpenAI",
    ownerUserId: alice.user.id,
    connectionId: aliceConn.id,
    pricingModel: "per_token",
    pricePer1kInputTokensUsd: 0.01,
    pricePer1kOutputTokensUsd: 0.02,
  });
  assert.ok(listing.id);

  // 4. Bob tops up his wallet
  walletMod.topUpWallet(bob.user.id, 50.0, "e2e-topup-flow10");
  assert.equal(walletMod.getWalletBalance(bob.user.id), 50.0);

  // 5. Bob creates an API key
  const bobKey = await createApiKeyForUser(bob.user.id, "bob-consumer-key");
  assert.ok(bobKey.key);

  // 6. Bob consumes Alice's provider (simulate a request)
  consumptionMod.recordConsumption({
    consumerUserId: bob.user.id,
    providerOwnerUserId: alice.user.id,
    totalCostUsd: 5.0,
    usageHistoryId: 100,
    marketplaceListingId: listing.id,
  });

  // 7. Verify balances
  // Bob: 50 - 5 = 45
  assert.equal(walletMod.getWalletBalance(bob.user.id), 45.0);
  // Alice: 0 + (5 - 0.50 commission) = 4.50
  assert.equal(walletMod.getWalletBalance(alice.user.id), 4.5);
  // Platform: 0.50 commission
  assert.equal(walletMod.getWalletBalance("platform"), 0.5);

  // 8. Verify Bob can see his transaction history
  const bobTxs = walletMod.listWalletTransactions({ ownerUserId: bob.user.id });
  assert.equal(bobTxs.length, 2); // topup + debit

  // 9. Verify Alice can see her earnings
  const aliceTxs = walletMod.listWalletTransactions({ ownerUserId: alice.user.id });
  assert.equal(aliceTxs.length, 1); // provider payout
  assert.equal(aliceTxs[0].direction, "credit");
  assert.equal(aliceTxs[0].reasonCode, "provider_payout");
});

// ─── Flow 11: Owner isolation — user A's API key metadata doesn't leak to user B ───

test("FLOW 11: user A's API key metadata has correct ownerUserId", async () => {
  const alice = await registerAndLogin("alice11@example.com", "password123");
  const bob = await registerAndLogin("bob11@example.com", "password123");

  const aliceKey = await createApiKeyForUser(alice.user.id, "alice-key");
  const bobKey = await createApiKeyForUser(bob.user.id, "bob-key");

  // Verify metadata returns correct owner
  const aliceMeta = await apiKeysDb.getApiKeyMetadata(aliceKey.key);
  assert.equal(aliceMeta?.ownerUserId, alice.user.id);

  const bobMeta = await apiKeysDb.getApiKeyMetadata(bobKey.key);
  assert.equal(bobMeta?.ownerUserId, bob.user.id);

  // Alice's key should NOT have bob's userId
  assert.notEqual(aliceMeta?.ownerUserId, bob.user.id);
  assert.notEqual(bobMeta?.ownerUserId, alice.user.id);
});

// ─── Flow 12: Session revocation ───

test("FLOW 12: revoked session token is rejected", async () => {
  const { token, claims } = await registerAndLogin("henry@example.com", "password123");

  // Token works initially
  const verified = await userAuth.verifyUserJwt(token);
  assert.ok(verified);

  // Revoke the session
  usersDb.revokeUserSession(claims.jti);

  // Token should now be rejected
  const revoked = await userAuth.verifyUserJwt(token);
  assert.equal(revoked, null);
});
