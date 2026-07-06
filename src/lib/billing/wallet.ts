/**
 * billing/wallet.ts — Per-user credit wallet with double-entry ledger.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance } from "@/lib/db/core";

type JsonRecord = Record<string, unknown>;

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  exec: (sql: string) => void;
  transaction: <TResult>(fn: (...args: unknown[]) => TResult) => (...args: unknown[]) => TResult;
}

export class WalletError extends Error {
  constructor(public code: string, message: string, public httpStatus: number = 400) {
    super(message);
    this.name = "WalletError";
  }
}

export type TxDirection = "credit" | "debit";
export type ReasonCode = "topup" | "consumption" | "provider_payout" | "commission" | "refund" | "withdrawal" | "adjustment";

export interface Wallet {
  id: string;
  ownerUserId: string;
  balanceCredits: number;
  currency: string;
  heldCredits: number;
  createdAt: string;
  updatedAt: string;
}

export interface WalletTransaction {
  id: string;
  walletId: string;
  counterpartyWalletId: string | null;
  direction: TxDirection;
  amount: number;
  currency: string;
  reason: string;
  reasonCode: ReasonCode;
  usageHistoryId: number | null;
  marketplaceListingId: string | null;
  idempotencyKey: string | null;
  metadata: JsonRecord | null;
  createdAt: string;
}

function getDb(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

export function getWalletById(id: string): Wallet | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as JsonRecord | undefined;
  return row ? rowToWallet(row) : null;
}

export function getWalletForUser(userId: string): Wallet | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM wallets WHERE owner_user_id = ?").get(userId) as JsonRecord | undefined;
  return row ? rowToWallet(row) : null;
}

export function getWalletBalance(userId: string): number {
  const wallet = getWalletForUser(userId);
  return wallet ? wallet.balanceCredits : 0;
}

export interface ListTransactionsFilter {
  walletId?: string;
  ownerUserId?: string;
  reasonCode?: ReasonCode;
  direction?: TxDirection;
  limit?: number;
  offset?: number;
}

export function listWalletTransactions(filter: ListTransactionsFilter = {}): WalletTransaction[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.walletId) { conditions.push("wt.wallet_id = @walletId"); params.walletId = filter.walletId; }
  if (filter.ownerUserId) { conditions.push("w.owner_user_id = @ownerUserId"); params.ownerUserId = filter.ownerUserId; }
  if (filter.reasonCode) { conditions.push("wt.reason_code = @reasonCode"); params.reasonCode = filter.reasonCode; }
  if (filter.direction) { conditions.push("wt.direction = @direction"); params.direction = filter.direction; }
  let sql = `SELECT wt.* FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id`;
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY wt.created_at DESC";
  if (filter.limit !== undefined) { sql += " LIMIT @limit"; params.limit = filter.limit; }
  if (filter.offset !== undefined) { sql += " OFFSET @offset"; params.offset = filter.offset; }
  const rows = db.prepare(sql).all(params) as JsonRecord[];
  return rows.map(rowToTx);
}

export interface ApplyTransactionInput {
  walletId: string;
  counterpartyWalletId?: string;
  direction: TxDirection;
  amount: number;
  reason: string;
  reasonCode: ReasonCode;
  usageHistoryId?: number;
  marketplaceListingId?: string;
  idempotencyKey: string;
  metadata?: JsonRecord;
}

export interface ApplyTransactionResult {
  transaction: WalletTransaction | null;
  replayed: boolean;
  wallet: Wallet;
}

export function applyWalletTransaction(input: ApplyTransactionInput): ApplyTransactionResult {
  if (input.amount <= 0) throw new WalletError("invalid_amount", "Amount must be positive");
  if (!input.idempotencyKey) throw new WalletError("missing_idempotency_key", "idempotencyKey is required");
  const db = getDb();

  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM wallet_transactions WHERE idempotency_key = ?").get(input.idempotencyKey) as JsonRecord | undefined;
    if (existing) {
      const wallet = getWalletById(input.walletId)!;
      return { transaction: rowToTx(existing), replayed: true, wallet };
    }

    const walletRow = db.prepare("SELECT * FROM wallets WHERE id = ?").get(input.walletId) as JsonRecord | undefined;
    if (!walletRow) throw new WalletError("wallet_not_found", `Wallet ${input.walletId} not found`, 404);
    const currentBalance = Number(walletRow.balance_credits ?? 0);

    if (input.direction === "debit" && input.amount > currentBalance) {
      throw new WalletError("insufficient_balance", `Insufficient balance: have ${currentBalance}, need ${input.amount}`, 402);
    }

    const txId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO wallet_transactions (id, wallet_id, counterparty_wallet_id, direction, amount, currency, reason, reason_code, usage_history_id, marketplace_listing_id, idempotency_key, metadata, created_at)
       VALUES (@id, @walletId, @counterpartyWalletId, @direction, @amount, @currency, @reason, @reasonCode, @usageHistoryId, @marketplaceListingId, @idempotencyKey, @metadata, @createdAt)`
    ).run({
      id: txId, walletId: input.walletId, counterpartyWalletId: input.counterpartyWalletId ?? null,
      direction: input.direction, amount: input.amount, currency: "USD", reason: input.reason,
      reasonCode: input.reasonCode, usageHistoryId: input.usageHistoryId ?? null,
      marketplaceListingId: input.marketplaceListingId ?? null, idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null, createdAt: now,
    });

    const delta = input.direction === "credit" ? input.amount : -input.amount;
    db.prepare(`UPDATE wallets SET balance_credits = balance_credits + @delta, updated_at = @updatedAt WHERE id = @walletId`).run({ walletId: input.walletId, delta, updatedAt: now });

    const updatedWallet = getWalletById(input.walletId)!;
    const txRow = db.prepare("SELECT * FROM wallet_transactions WHERE id = ?").get(txId) as JsonRecord;
    return { transaction: rowToTx(txRow), replayed: false, wallet: updatedWallet };
  });

  return tx();
}

export function topUpWallet(userId: string, amount: number, idempotencyKey: string, reason = "Manual top-up", metadata?: JsonRecord): ApplyTransactionResult {
  const wallet = getWalletForUser(userId);
  if (!wallet) throw new WalletError("wallet_not_found", `No wallet for user ${userId}`, 404);
  return applyWalletTransaction({ walletId: wallet.id, direction: "credit", amount, reason, reasonCode: "topup", idempotencyKey, metadata });
}

export function debitConsumer(userId: string, amount: number, idempotencyKey: string, usageHistoryId?: number, metadata?: JsonRecord): ApplyTransactionResult {
  const wallet = getWalletForUser(userId);
  if (!wallet) throw new WalletError("wallet_not_found", `No wallet for user ${userId}`, 404);
  return applyWalletTransaction({ walletId: wallet.id, direction: "debit", amount, reason: "Inference consumption", reasonCode: "consumption", usageHistoryId, idempotencyKey, metadata });
}

export function creditProvider(providerOwnerId: string, amount: number, consumerWalletId: string, idempotencyKey: string, usageHistoryId?: number, marketplaceListingId?: string, metadata?: JsonRecord): ApplyTransactionResult {
  const wallet = getWalletForUser(providerOwnerId);
  if (!wallet) throw new WalletError("wallet_not_found", `No wallet for provider ${providerOwnerId}`, 404);
  return applyWalletTransaction({ walletId: wallet.id, counterpartyWalletId: consumerWalletId, direction: "credit", amount, reason: "Provider payout for inference", reasonCode: "provider_payout", usageHistoryId, marketplaceListingId, idempotencyKey, metadata });
}

export function creditPlatformCommission(amount: number, consumerWalletId: string, idempotencyKey: string, usageHistoryId?: number, metadata?: JsonRecord): ApplyTransactionResult {
  return applyWalletTransaction({ walletId: "wallet-platform", counterpartyWalletId: consumerWalletId, direction: "credit", amount, reason: "Platform commission", reasonCode: "commission", usageHistoryId, idempotencyKey, metadata });
}

function rowToWallet(row: JsonRecord): Wallet {
  return {
    id: String(row.id), ownerUserId: String(row.owner_user_id),
    balanceCredits: Number(row.balance_credits ?? 0), currency: String(row.currency ?? "USD"),
    heldCredits: Number(row.held_credits ?? 0), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function rowToTx(row: JsonRecord): WalletTransaction {
  let metadata: JsonRecord | null = null;
  if (typeof row.metadata === "string" && row.metadata.length > 0) {
    try { metadata = JSON.parse(row.metadata) as JsonRecord; } catch { metadata = null; }
  }
  return {
    id: String(row.id), walletId: String(row.wallet_id),
    counterpartyWalletId: row.counterparty_wallet_id ? String(row.counterparty_wallet_id) : null,
    direction: row.direction === "credit" ? "credit" : "debit", amount: Number(row.amount),
    currency: String(row.currency ?? "USD"), reason: String(row.reason ?? ""),
    reasonCode: row.reason_code as ReasonCode,
    usageHistoryId: row.usage_history_id != null ? Number(row.usage_history_id) : null,
    marketplaceListingId: row.marketplace_listing_id ? String(row.marketplace_listing_id) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null, metadata,
    createdAt: String(row.created_at),
  };
}
