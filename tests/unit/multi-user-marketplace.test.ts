import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-marketplace-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_MULTI_USER = "true";
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const usersDb = await import("../../src/lib/db/users.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
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

function seedUser(email: string) {
  return usersDb.createUser({ email, passwordHash: "$2b$12$dummy" });
}

async function seedConnection(ownerUserId: string, provider: string, isPublic = false) {
  const nonce = Math.random().toString(36).slice(2, 10);
  return providersDb.createProviderConnection({
    provider, authType: "apikey", name: `conn-${nonce}`, apiKey: `sk-${nonce}`,
    ownerUserId, isPublic,
  });
}

test("createListing publishes a connection as a per_token listing", async () => {
  const owner = seedUser("owner1@example.com");
  const conn = await seedConnection(owner.id, "openai");
  const listing = listingsMod.createListing({
    title: "GPT-4 shared", description: "Cheap GPT-4 access",
    ownerUserId: owner.id, connectionId: conn.id, pricingModel: "per_token",
    pricePer1kInputTokensUsd: 0.03, pricePer1kOutputTokensUsd: 0.06, category: "openai",
  });
  assert.ok(listing.id);
  assert.equal(listing.pricingModel, "per_token");
  assert.equal(listing.isActive, true);
  const db = core.getDbInstance();
  const row = db.prepare("SELECT is_public, marketplace_listing_id FROM provider_connections WHERE id = ?").get(conn.id) as { is_public: number; marketplace_listing_id: string | null };
  assert.equal(row.is_public, 1);
  assert.equal(row.marketplace_listing_id, listing.id);
});

test("createListing rejects when neither connectionId nor quotaPoolId is provided", () => {
  const owner = seedUser("owner2@example.com");
  assert.throws(() => listingsMod.createListing({
    title: "no resource", ownerUserId: owner.id, pricingModel: "per_token", pricePer1kInputTokensUsd: 0.01,
  }), (err: unknown) => (err as { code?: string }).code === "missing_resource");
});

test("createListing auto-generates a unique slug from the title", () => {
  const owner = seedUser("owner4@example.com");
  const l1 = listingsMod.createListing({ title: "My Cool GPT", ownerUserId: owner.id, connectionId: "fake-1", pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  const l2 = listingsMod.createListing({ title: "My Cool GPT", ownerUserId: owner.id, connectionId: "fake-2", pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  assert.equal(l1.slug, "my-cool-gpt");
  assert.equal(l2.slug, "my-cool-gpt-1");
});

test("listListings filters by ownerUserId", async () => {
  const alice = seedUser("alice@example.com");
  const bob = seedUser("bob@example.com");
  const aliceConn = await seedConnection(alice.id, "openai");
  const bobConn = await seedConnection(bob.id, "anthropic");
  listingsMod.createListing({ title: "Alice's listing", ownerUserId: alice.id, connectionId: aliceConn.id, pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  listingsMod.createListing({ title: "Bob's listing", ownerUserId: bob.id, connectionId: bobConn.id, pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  const alices = listingsMod.listListings({ ownerUserId: alice.id });
  assert.equal(alices.length, 1);
  assert.equal(alices[0].ownerUserId, alice.id);
});

test("listListings search matches title case-insensitively", () => {
  const owner = seedUser("owner6@example.com");
  listingsMod.createListing({ title: "GPT-4 Turbo", ownerUserId: owner.id, connectionId: "fake-s1", pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  listingsMod.createListing({ title: "Claude 3.5 Sonnet", ownerUserId: owner.id, connectionId: "fake-s2", pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  const gptResults = listingsMod.listListings({ search: "gpt" });
  assert.equal(gptResults.length, 1);
});

test("updateListing rejects non-owner with forbidden", async () => {
  const alice = seedUser("alice2@example.com");
  const bob = seedUser("bob2@example.com");
  const conn = await seedConnection(alice.id, "openai");
  const listing = listingsMod.createListing({ title: "Alice's", ownerUserId: alice.id, connectionId: conn.id, pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  assert.throws(() => listingsMod.updateListing(listing.id, { title: "Hacked" }, bob.id), (err: unknown) => (err as { code?: string }).code === "forbidden" && err.httpStatus === 403);
});

test("deleteListing unpublishes the connection and removes the row", async () => {
  const owner = seedUser("owner7@example.com");
  const conn = await seedConnection(owner.id, "openai");
  const listing = listingsMod.createListing({ title: "To be deleted", ownerUserId: owner.id, connectionId: conn.id, pricingModel: "per_request", pricePerRequestUsd: 0.001 });
  const deleted = listingsMod.deleteListing(listing.id, owner.id);
  assert.equal(deleted, true);
  assert.equal(listingsMod.getListingById(listing.id), null);
  const db = core.getDbInstance();
  const row = db.prepare("SELECT is_public, marketplace_listing_id FROM provider_connections WHERE id = ?").get(conn.id) as { is_public: number; marketplace_listing_id: string | null };
  assert.equal(row.is_public, 0);
  assert.equal(row.marketplace_listing_id, null);
});

test("computeListingCost calculates per_token cost correctly", () => {
  const listing = {
    id: "test", slug: "test", title: "test", description: null, ownerUserId: "owner",
    connectionId: "conn", quotaPoolId: null, pricingModel: "per_token" as const,
    pricePer1kInputTokensUsd: 0.03, pricePer1kOutputTokensUsd: 0.06, pricePerRequestUsd: 0,
    isActive: true, isFeatured: false, category: null, tags: null, totalRequests: 0,
    totalTokens: 0, averageRating: null, ratingCount: 0, createdAt: "2024-01-01", updatedAt: "2024-01-01",
  };
  assert.equal(listingsMod.computeListingCost(listing, { inputTokens: 5000, outputTokens: 2000, requests: 1 }), 0.27);
});

test("computeListingCost calculates per_request cost correctly", () => {
  const listing = {
    id: "test2", slug: "test2", title: "test2", description: null, ownerUserId: "owner",
    connectionId: "conn", quotaPoolId: null, pricingModel: "per_request" as const,
    pricePer1kInputTokensUsd: 0, pricePer1kOutputTokensUsd: 0, pricePerRequestUsd: 0.005,
    isActive: true, isFeatured: false, category: null, tags: null, totalRequests: 0,
    totalTokens: 0, averageRating: null, ratingCount: 0, createdAt: "2024-01-01", updatedAt: "2024-01-01",
  };
  assert.equal(listingsMod.computeListingCost(listing, { inputTokens: 10000, outputTokens: 5000, requests: 3 }), 0.015);
});

// ─── Owner scoping tests ───

test("getProviderConnections with no filter returns ALL rows (backward compat)", async () => {
  const userA = seedUser("alice@example.com");
  const userB = seedUser("bob@example.com");
  await seedConnection(userA.id, "openai");
  await seedConnection(userB.id, "openai");
  await seedConnection("system", "anthropic");
  const all = await providersDb.getProviderConnections();
  assert.equal(all.length, 3);
});

test("getProviderConnections scoped to a user returns only their rows", async () => {
  const userA = seedUser("a@example.com");
  const userB = seedUser("b@example.com");
  await seedConnection(userA.id, "openai");
  await seedConnection(userA.id, "anthropic");
  await seedConnection(userB.id, "openai");
  const alicesOnly = await providersDb.getProviderConnections({ ownerUserId: userA.id });
  assert.equal(alicesOnly.length, 2);
  assert.ok(alicesOnly.every((c: Record<string, unknown>) => c.ownerUserId === userA.id));
});

test("getProviderConnections with includePublic sees other users' public rows", async () => {
  const userA = seedUser("aa@example.com");
  const userB = seedUser("bb@example.com");
  await seedConnection(userA.id, "openai", true);
  await seedConnection(userA.id, "anthropic", false);
  await seedConnection(userB.id, "openai", false);
  const bPlusPublic = await providersDb.getProviderConnections({ ownerUserId: userB.id, includePublic: true });
  assert.equal(bPlusPublic.length, 2);
  const owners = new Set(bPlusPublic.map((c: Record<string, unknown>) => c.ownerUserId));
  assert.ok(owners.has(userB.id));
  assert.ok(owners.has(userA.id));
});

test("createProviderConnection defaults owner_user_id to 'system' when not provided", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "openai", authType: "apikey", name: "legacy-conn", apiKey: "sk-legacy",
  });
  assert.equal(conn.ownerUserId, "system");
});

test("createProviderConnection stores is_public=1 when requested", async () => {
  const userA = seedUser("pub@example.com");
  const conn = await providersDb.createProviderConnection({
    provider: "openai", authType: "apikey", name: "shared-conn", apiKey: "sk-share",
    ownerUserId: userA.id, isPublic: true,
  });
  assert.equal(conn.isPublic, 1);
});

test("listApiKeysForUser returns only that user's keys", async () => {
  const alice = seedUser("aliceK@example.com");
  const bob = seedUser("bobK@example.com");
  const aliceKey = await apiKeysDb.createApiKey("alice-1", "machine-a1");
  const bobKey = await apiKeysDb.createApiKey("bob-1", "machine-b1");
  const db = core.getDbInstance();
  db.prepare("UPDATE api_keys SET owner_user_id = ? WHERE id = ?").run(alice.id, aliceKey.id);
  db.prepare("UPDATE api_keys SET owner_user_id = ? WHERE id = ?").run(bob.id, bobKey.id);
  const alices = usersDb.listApiKeysForUser(alice.id);
  assert.equal(alices.length, 1);
  const bobs = usersDb.listApiKeysForUser(bob.id);
  assert.equal(bobs.length, 1);
});

test("listProviderConnectionsForUser returns only that user's connections", async () => {
  const alice = seedUser("aliceP@example.com");
  const bob = seedUser("bobP@example.com");
  const aliceConn = await seedConnection(alice.id, "openai");
  await seedConnection(bob.id, "anthropic");
  const alices = usersDb.listProviderConnectionsForUser(alice.id);
  assert.equal(alices.length, 1);
  assert.equal(alices[0].id, aliceConn.id);
});
