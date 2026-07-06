/**
 * auth/userAuth.ts — Multi-user authentication: register, login, JWT mint/verify.
 *
 * JWT shape: { sub: userId, role, jti, mu: true }
 * mu = multi-user marker. Signed with the same JWT_SECRET as legacy session.
 */

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { v4 as uuidv4 } from "uuid";
import {
  createUser,
  getUserByEmail,
  getUserCredential,
  getUserById,
  updateUser,
  createUserSession,
  isUserSessionRevoked,
  updateUserPassword,
  type User,
  type UserRole,
} from "@/lib/db/users";

const BCRYPT_COST = 12;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(public code: string, message: string, public httpStatus: number = 400) {
    super(message);
    this.name = "AuthError";
  }
}

export interface RegisteredUser {
  user: User;
  token: string;
}

export interface LoginResult {
  user: User;
  token: string;
  legacyFallback: boolean;
}

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new AuthError("missing_jwt_secret", "JWT_SECRET is not configured", 500);
  }
  return new TextEncoder().encode(secret);
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}

export async function registerUser(input: RegisterInput): Promise<RegisteredUser> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new AuthError("invalid_email", "A valid email address is required");
  }
  if (input.password.length < 8) {
    throw new AuthError("weak_password", "Password must be at least 8 characters long");
  }
  if (input.password.length > 256) {
    throw new AuthError("weak_password", "Password is too long");
  }
  if (getUserByEmail(email)) {
    throw new AuthError("email_taken", "An account with this email already exists", 409);
  }
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const user = createUser({
    email, displayName: input.displayName, passwordHash, role: input.role ?? "user",
  });
  const token = await mintUserJwt(user);
  return { user, token };
}

export interface LoginInput {
  email?: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
}

export async function loginUser(input: LoginInput): Promise<LoginResult> {
  if (!input.password) {
    throw new AuthError("missing_password", "Password is required");
  }
  if (input.email) {
    const email = input.email.trim().toLowerCase();
    const user = getUserByEmail(email);
    if (!user) {
      throw new AuthError("invalid_credentials", "Invalid email or password", 401);
    }
    if (!user.isActive) {
      throw new AuthError("account_disabled", "This account has been disabled", 403);
    }
    const cred = getUserCredential(user.id);
    if (!cred) {
      throw new AuthError("invalid_credentials", "Invalid email or password", 401);
    }
    const ok = await bcrypt.compare(input.password, cred.passwordHash);
    if (!ok) {
      throw new AuthError("invalid_credentials", "Invalid email or password", 401);
    }
    const now = new Date().toISOString();
    updateUser(user.id, { lastLoginAt: now });
    const refreshed = getUserById(user.id)!;
    const token = await mintUserJwt(refreshed);
    return { user: refreshed, token, legacyFallback: false };
  }
  throw new AuthError("missing_email", "Email is required in multi-user mode");
}

export interface UserJwtClaims {
  sub: string;
  role: UserRole;
  jti: string;
  mu: boolean;
}

export async function mintUserJwt(user: User): Promise<string> {
  const jti = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await new SignJWT({ role: user.role, mu: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(getJwtSecret());
  createUserSession({
    userId: user.id, tokenJti: jti,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    userAgent: undefined, ipAddress: undefined,
  });
  return token;
}

export async function verifyUserJwt(token: string): Promise<UserJwtClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { algorithms: ["HS256"] });
    const sub = payload.sub;
    if (typeof sub !== "string" || !sub) return null;
    const jti = payload.jti;
    if (typeof jti !== "string" || !jti) return null;
    if (isUserSessionRevoked(jti)) return null;
    const role = (payload.role as UserRole) ?? "user";
    return { sub, role, jti, mu: payload.mu === true };
  } catch {
    return null;
  }
}

export async function changeUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const cred = getUserCredential(userId);
  if (!cred) {
    throw new AuthError("not_found", "User credential not found", 404);
  }
  const ok = await bcrypt.compare(currentPassword, cred.passwordHash);
  if (!ok) {
    throw new AuthError("invalid_credentials", "Current password is incorrect", 401);
  }
  if (newPassword.length < 8) {
    throw new AuthError("weak_password", "Password must be at least 8 characters long");
  }
  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  updateUserPassword(userId, hash, "bcrypt");
}
