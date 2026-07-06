/**
 * db/users.ts — User account CRUD for multi-user platform mode.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance, rowToCamel, cleanNulls } from "./core";
import { backupDbFile } from "./backup";
import { invalidateDbCache } from "./readCache";

type JsonRecord = Record<string, unknown>;

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

export type UserRole = "user" | "provider" | "admin";

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  isEmailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface UserCredential {
  userId: string;
  passwordHash: string;
  passwordAlgo: string;
  passwordUpdatedAt: string;
}

export function getUserById(id: string): User | null {
  const db = getDbInstance() as unknown as DbLike;
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as JsonRecord | undefined;
  if (!row) return null;
  return rowToUser(row);
}

export function getUserByEmail(email: string): User | null {
  const db = getDbInstance() as unknown as DbLike;
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as JsonRecord | undefined;
  if (!row) return null;
  return rowToUser(row);
}

export function listUsers(filter: { role?: UserRole; isActive?: boolean } = {}): User[] {
  const db = getDbInstance() as unknown as DbLike;
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.role) { conditions.push("role = @role"); params.role = filter.role; }
  if (filter.isActive !== undefined) { conditions.push("is_active = @isActive"); params.isActive = filter.isActive ? 1 : 0; }
  let sql = "SELECT * FROM users";
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY created_at ASC";
  const rows = db.prepare(sql).all(params) as JsonRecord[];
  return rows.map(rowToUser);
}

export function getUserCredential(userId: string): UserCredential | null {
  const db = getDbInstance() as unknown as DbLike;
  const row = db.prepare("SELECT * FROM user_credentials WHERE user_id = ?").get(userId) as JsonRecord | undefined;
  if (!row) return null;
  const camel = rowToCamel(row) as JsonRecord;
  return {
    userId: String(camel.userId),
    passwordHash: String(camel.passwordHash),
    passwordAlgo: String(camel.passwordAlgo ?? "bcrypt"),
    passwordUpdatedAt: String(camel.passwordUpdatedAt),
  };
}

export interface CreateUserInput {
  email: string;
  displayName?: string;
  role?: UserRole;
  isActive?: boolean;
  passwordHash: string;
  passwordAlgo?: string;
}

export function createUser(input: CreateUserInput): User {
  const db = getDbInstance() as unknown as DbLike;
  const id = uuidv4();
  const now = new Date().toISOString();
  const email = input.email.toLowerCase().trim();
  const role: UserRole = input.role ?? "user";

  db.prepare(
    `INSERT INTO users (id, email, display_name, role, is_active, is_email_verified, created_at, updated_at)
     VALUES (@id, @email, @displayName, @role, @isActive, 0, @createdAt, @updatedAt)`
  ).run({ id, email, displayName: input.displayName ?? null, role, isActive: input.isActive === false ? 0 : 1, createdAt: now, updatedAt: now });

  db.prepare(
    `INSERT INTO user_credentials (user_id, password_hash, password_algo, password_updated_at)
     VALUES (@userId, @passwordHash, @passwordAlgo, @passwordUpdatedAt)`
  ).run({ userId: id, passwordHash: input.passwordHash, passwordAlgo: input.passwordAlgo ?? "bcrypt", passwordUpdatedAt: now });

  db.prepare(
    `INSERT OR IGNORE INTO wallets (id, owner_user_id, balance_credits, currency, created_at, updated_at)
     VALUES (@id, @ownerUserId, 0, 'USD', @createdAt, @updatedAt)`
  ).run({ id: `wallet-${id}`, ownerUserId: id, createdAt: now, updatedAt: now });

  backupDbFile("pre-write");
  invalidateDbCache();
  return getUserById(id)!;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  isActive?: boolean;
  isEmailVerified?: boolean;
  lastLoginAt?: string;
}

export function updateUser(id: string, patch: UpdateUserInput): User | null {
  const db = getDbInstance() as unknown as DbLike;
  const existing = getUserById(id);
  if (!existing) return null;
  const sets: string[] = ["updated_at = @updatedAt"];
  const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
  if (patch.displayName !== undefined) { sets.push("display_name = @displayName"); params.displayName = patch.displayName; }
  if (patch.role !== undefined) { sets.push("role = @role"); params.role = patch.role; }
  if (patch.isActive !== undefined) { sets.push("is_active = @isActive"); params.isActive = patch.isActive ? 1 : 0; }
  if (patch.isEmailVerified !== undefined) { sets.push("is_email_verified = @isEmailVerified"); params.isEmailVerified = patch.isEmailVerified ? 1 : 0; }
  if (patch.lastLoginAt !== undefined) { sets.push("last_login_at = @lastLoginAt"); params.lastLoginAt = patch.lastLoginAt; }
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = @id`).run(params);
  backupDbFile("pre-write");
  invalidateDbCache();
  return getUserById(id);
}

export function updateUserPassword(userId: string, passwordHash: string, passwordAlgo: string = "bcrypt"): void {
  const db = getDbInstance() as unknown as DbLike;
  const now = new Date().toISOString();
  db.prepare(`UPDATE user_credentials SET password_hash = @passwordHash, password_algo = @passwordAlgo, password_updated_at = @passwordUpdatedAt WHERE user_id = @userId`).run({ userId, passwordHash, passwordAlgo, passwordUpdatedAt: now });
  backupDbFile("pre-write");
}

export interface CreateUserSessionInput {
  userId: string;
  tokenJti: string;
  expiresAt: string;
  userAgent?: string;
  ipAddress?: string;
}

export function createUserSession(input: CreateUserSessionInput): string {
  const db = getDbInstance() as unknown as DbLike;
  const id = uuidv4();
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, token_jti, issued_at, expires_at, user_agent, ip_address)
     VALUES (@id, @userId, @tokenJti, @issuedAt, @expiresAt, @userAgent, @ipAddress)`
  ).run({ id, userId: input.userId, tokenJti: input.tokenJti, issuedAt: new Date().toISOString(), expiresAt: input.expiresAt, userAgent: input.userAgent ?? null, ipAddress: input.ipAddress ?? null });
  return id;
}

export function revokeUserSession(jti: string): boolean {
  const db = getDbInstance() as unknown as DbLike;
  const result = db.prepare(`UPDATE user_sessions SET revoked_at = @revokedAt WHERE token_jti = @jti AND revoked_at IS NULL`).run({ jti, revokedAt: new Date().toISOString() });
  return (result.changes ?? 0) > 0;
}

export function isUserSessionRevoked(jti: string): boolean {
  const db = getDbInstance() as unknown as DbLike;
  const row = db.prepare("SELECT revoked_at FROM user_sessions WHERE token_jti = ?").get(jti) as { revoked_at?: string | null } | undefined;
  if (!row) return true;
  return row.revoked_at !== null && row.revoked_at !== undefined;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string | null;
  isActive: boolean;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export function listApiKeysForUser(userId: string): ApiKeySummary[] {
  const db = getDbInstance() as unknown as DbLike;
  const rows = db.prepare(`SELECT id, name, key_prefix, revoked_at, expires_at, scopes, created_at, last_used_at FROM api_keys WHERE owner_user_id = ? ORDER BY created_at DESC`).all(userId) as JsonRecord[];
  const nowIso = new Date().toISOString();
  return rows.map((r) => {
    const camel = rowToCamel(r) as JsonRecord;
    const revokedAt = camel.revokedAt ? String(camel.revokedAt) : null;
    const expiresAt = camel.expiresAt ? String(camel.expiresAt) : null;
    const isActive = !revokedAt && (!expiresAt || expiresAt > nowIso);
    return {
      id: String(camel.id), name: String(camel.name ?? ""),
      keyPrefix: camel.keyPrefix ? String(camel.keyPrefix) : null,
      isActive, scopes: parseScopes(camel.scopes),
      createdAt: String(camel.createdAt ?? ""),
      lastUsedAt: camel.lastUsedAt ? String(camel.lastUsedAt) : null,
    };
  });
}

export interface ProviderConnectionSummary {
  id: string;
  provider: string;
  name: string | null;
  authType: string | null;
  isActive: boolean;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export function listProviderConnectionsForUser(userId: string): ProviderConnectionSummary[] {
  const db = getDbInstance() as unknown as DbLike;
  const rows = db.prepare(`SELECT id, provider, name, auth_type, is_active, is_public, created_at, updated_at FROM provider_connections WHERE owner_user_id = ? ORDER BY created_at DESC`).all(userId) as JsonRecord[];
  return rows.map((r) => {
    const camel = rowToCamel(r) as JsonRecord;
    return {
      id: String(camel.id), provider: String(camel.provider ?? ""),
      name: camel.name ? String(camel.name) : null,
      authType: camel.authType ? String(camel.authType) : null,
      isActive: Boolean(camel.isActive ?? 1), isPublic: Boolean(camel.isPublic ?? 0),
      createdAt: String(camel.createdAt ?? ""), updatedAt: String(camel.updatedAt ?? ""),
    };
  });
}

function parseScopes(raw: unknown): string[] {
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function rowToUser(row: JsonRecord): User {
  const camel = rowToCamel(row) as JsonRecord;
  const cleaned = cleanNulls(camel) as JsonRecord;
  return {
    id: String(cleaned.id), email: String(cleaned.email),
    displayName: cleaned.displayName ? String(cleaned.displayName) : null,
    role: (cleaned.role as UserRole) ?? "user",
    isActive: Boolean(cleaned.isActive ?? 1), isEmailVerified: Boolean(cleaned.isEmailVerified ?? 0),
    createdAt: String(cleaned.createdAt), updatedAt: String(cleaned.updatedAt),
    lastLoginAt: cleaned.lastLoginAt ? String(cleaned.lastLoginAt) : null,
  };
}

export const SYSTEM_USER_ID = "system";
export const PLATFORM_USER_ID = "platform";

export function isMultiUserModeEnabled(settings?: { multiUserEnabled?: boolean }): boolean {
  if (process.env.OMNIROUTE_MULTI_USER === "true") return true;
  if (settings?.multiUserEnabled === true) return true;
  return false;
}
