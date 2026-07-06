/**
 * billing/commission.ts — Commission rate management and split calculation.
 */

import { getDbInstance } from "@/lib/db/core";

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}
interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

export interface CommissionSettings {
  rate: number;
  minPayoutUsd: number;
  updatedAt: string;
  updatedBy: string | null;
}

export function getCommissionSettings(): CommissionSettings {
  const db = getDbInstance() as unknown as DbLike;
  const row = db.prepare("SELECT * FROM commission_settings WHERE id = 1").get() as { commission_rate: number; min_payout_usd: number; updated_at: string; updated_by?: string | null } | undefined;
  if (!row) return { rate: 0.10, minPayoutUsd: 10.0, updatedAt: new Date().toISOString(), updatedBy: null };
  return { rate: Number(row.commission_rate), minPayoutUsd: Number(row.min_payout_usd), updatedAt: String(row.updated_at), updatedBy: row.updated_by ?? null };
}

export function updateCommissionRate(rate: number, updatedBy: string): CommissionSettings {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`Invalid commission rate: ${rate} (must be 0..1)`);
  }
  const db = getDbInstance() as unknown as DbLike;
  const now = new Date().toISOString();
  db.prepare(`UPDATE commission_settings SET commission_rate = @rate, updated_at = @updatedAt, updated_by = @updatedBy WHERE id = 1`).run({ rate, updatedAt: now, updatedBy });
  return getCommissionSettings();
}

export interface CommissionSplit {
  totalCost: number;
  commissionAmount: number;
  providerPayout: number;
  rate: number;
}

export function splitCost(totalCost: number, rate?: number): CommissionSplit {
  const effectiveRate = rate ?? getCommissionSettings().rate;
  if (!Number.isFinite(totalCost) || totalCost < 0) {
    return { totalCost: 0, commissionAmount: 0, providerPayout: 0, rate: effectiveRate };
  }
  const commission = round6(totalCost * effectiveRate);
  const payout = round6(totalCost - commission);
  return { totalCost: round6(totalCost), commissionAmount: commission, providerPayout: payout, rate: effectiveRate };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
