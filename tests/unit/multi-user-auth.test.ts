import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-users-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_MULTI_USER = "true";
process.env.JWT_SECRET = "test-jwt-secret-for-multi-user-tests-32chars";

const core = await import("../../src/lib/db/core.ts");
const usersDb = await import("../../src/lib/db/users.ts");
const userAuth = await import("../../src/lib/auth/userAuth.ts");

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

test("getUserByEmail returns null for unknown email", () => {
  assert.equal(usersDb.getUserByEmail("nobody@example.com"), null);
});

test("createUser inserts a user, credential, and wallet atomically", () => {
  const user = usersDb.createUser({ email: "alice@example.com", displayName: "Alice", passwordHash: "$2b$12$dummy" });
  assert.ok(user.id);
  assert.equal(user.email, "alice@example.com");
  assert.equal(user.role, "user");
  const cred = usersDb.getUserCredential(user.id);
  assert.ok(cred);
  const db = core.getDbInstance();
  const wallet = db.prepare("SELECT * FROM wallets WHERE owner_user_id = ?").get(user.id) as any;
  assert.ok(wallet);
  assert.equal(wallet.balance_credits, 0);
});

test("createUser rejects duplicate emails", () => {
  usersDb.createUser({ email: "dup@example.com", passwordHash: "x" });
  assert.throws(() => usersDb.createUser({ email: "DUP@example.com", passwordHash: "y" }));
});

test("updateUser patches fields", () => {
  const user = usersDb.createUser({ email: "bob@example.com", passwordHash: "x" });
  const updated = usersDb.updateUser(user.id, { displayName: "Bob Updated", role: "provider" });
  assert.ok(updated);
  assert.equal(updated.displayName, "Bob Updated");
  assert.equal(updated.role, "provider");
});

test("registerUser creates a usable account and returns a JWT", async () => {
  const { user, token } = await userAuth.registerUser({ email: "carol@example.com", password: "super-secret-pw", displayName: "Carol" });
  assert.ok(token);
  assert.equal(user.email, "carol@example.com");
  const claims = await userAuth.verifyUserJwt(token);
  assert.ok(claims);
  assert.equal(claims.sub, user.id);
  assert.equal(claims.mu, true);
});

test("registerUser rejects short passwords", async () => {
  await assert.rejects(() => userAuth.registerUser({ email: "weak@example.com", password: "123" }), (err: any) => err.code === "weak_password");
});

test("registerUser rejects duplicate email", async () => {
  await userAuth.registerUser({ email: "dup2@example.com", password: "password1" });
  await assert.rejects(() => userAuth.registerUser({ email: "DUP2@example.com", password: "password1" }), (err: any) => err.code === "email_taken");
});

test("loginUser succeeds with correct credentials", async () => {
  await userAuth.registerUser({ email: "dave@example.com", password: "correct-horse-battery" });
  const result = await userAuth.loginUser({ email: "dave@example.com", password: "correct-horse-battery" });
  assert.equal(result.user.email, "dave@example.com");
  assert.ok(result.token);
  assert.equal(result.legacyFallback, false);
});

test("loginUser fails with wrong password", async () => {
  await userAuth.registerUser({ email: "eve@example.com", password: "right-password-1" });
  await assert.rejects(() => userAuth.loginUser({ email: "eve@example.com", password: "wrong" }), (err: any) => err.code === "invalid_credentials");
});

test("loginUser fails for disabled account", async () => {
  const { user } = await userAuth.registerUser({ email: "disabled@example.com", password: "password123" });
  usersDb.updateUser(user.id, { isActive: false });
  await assert.rejects(() => userAuth.loginUser({ email: "disabled@example.com", password: "password123" }), (err: any) => err.code === "account_disabled");
});

test("verifyUserJwt returns null for revoked session", async () => {
  const { token } = await userAuth.registerUser({ email: "revoke@example.com", password: "password123" });
  const claims = await userAuth.verifyUserJwt(token);
  assert.ok(claims);
  usersDb.revokeUserSession(claims.jti);
  assert.equal(await userAuth.verifyUserJwt(token), null);
});

test("changeUserPassword rejects wrong current password", async () => {
  const { user } = await userAuth.registerUser({ email: "change@example.com", password: "original-pw-1" });
  await assert.rejects(() => userAuth.changeUserPassword(user.id, "wrong", "newpassword"), (err: any) => err.code === "invalid_credentials");
});

test("changeUserPassword succeeds with correct current password", async () => {
  const { user } = await userAuth.registerUser({ email: "change2@example.com", password: "original-pw-1" });
  await userAuth.changeUserPassword(user.id, "original-pw-1", "newpassword-1");
  await assert.rejects(() => userAuth.loginUser({ email: "change2@example.com", password: "original-pw-1" }), (err: any) => err.code === "invalid_credentials");
  const result = await userAuth.loginUser({ email: "change2@example.com", password: "newpassword-1" });
  assert.equal(result.user.email, "change2@example.com");
});

test("isMultiUserModeEnabled reads env var", () => {
  const prev = process.env.OMNIROUTE_MULTI_USER;
  process.env.OMNIROUTE_MULTI_USER = "true";
  assert.equal(usersDb.isMultiUserModeEnabled(), true);
  process.env.OMNIROUTE_MULTI_USER = "false";
  assert.equal(usersDb.isMultiUserModeEnabled(), false);
  if (prev === undefined) delete process.env.OMNIROUTE_MULTI_USER; else process.env.OMNIROUTE_MULTI_USER = prev;
});
