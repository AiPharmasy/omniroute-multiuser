/**
 * billing/consumption.ts — Hook used by the chat pipeline to record per-call
 * consumption against the consumer's wallet and credit the provider owner +
 * platform commission.
 */

import {
  applyWalletTransaction,
  getWalletForUser,
  WalletError,
  type ApplyTransactionResult,
} from "./wallet";
import { splitCost } from "./commission";
import { SYSTEM_USER_ID } from "@/lib/db/users";

export interface ConsumptionInput {
  consumerUserId: string;
  providerOwnerUserId: string;
  totalCostUsd: number;
  usageHistoryId: number;
  marketplaceListingId?: string;
  metadata?: Record<string, unknown>;
}

export interface ConsumptionResult {
  debit: ApplyTransactionResult;
  providerCredit: ApplyTransactionResult | null;
  commissionCredit: ApplyTransactionResult;
  split: { totalCost: number; commissionAmount: number; providerPayout: number; rate: number };
  insufficientBalance: boolean;
}

export function recordConsumption(input: ConsumptionInput): ConsumptionResult {
  const split = splitCost(input.totalCostUsd);
  const idemBase = `usage-${input.usageHistoryId}`;

  if (input.consumerUserId === input.providerOwnerUserId) {
    const consumerWallet = getWalletForUser(input.consumerUserId);
    const noOpResult: ApplyTransactionResult = { transaction: null, replayed: true, wallet: consumerWallet! };
    return {
      debit: noOpResult, providerCredit: null, commissionCredit: noOpResult,
      split: { ...split, totalCost: 0, commissionAmount: 0, providerPayout: 0 },
      insufficientBalance: false,
    };
  }

  let debit: ApplyTransactionResult;
  let insufficient = false;
  try {
    debit = applyWalletTransaction({
      walletId: getWalletForUser(input.consumerUserId)!.id,
      direction: "debit", amount: split.totalCost, reason: "Inference consumption",
      reasonCode: "consumption", usageHistoryId: input.usageHistoryId,
      marketplaceListingId: input.marketplaceListingId, idempotencyKey: `${idemBase}-debit`, metadata: input.metadata,
    });
  } catch (err) {
    if (err instanceof WalletError && err.code === "insufficient_balance") {
      insufficient = true;
      const wallet = getWalletForUser(input.consumerUserId)!;
      debit = { transaction: null, replayed: false, wallet };
    } else { throw err; }
  }

  let providerCredit: ApplyTransactionResult | null = null;
  if (input.providerOwnerUserId !== SYSTEM_USER_ID && split.providerPayout > 0) {
    const providerWallet = getWalletForUser(input.providerOwnerUserId);
    if (providerWallet) {
      providerCredit = applyWalletTransaction({
        walletId: providerWallet.id, counterpartyWalletId: debit.wallet.id,
        direction: "credit", amount: split.providerPayout, reason: "Provider payout for inference",
        reasonCode: "provider_payout", usageHistoryId: input.usageHistoryId,
        marketplaceListingId: input.marketplaceListingId, idempotencyKey: `${idemBase}-provider`, metadata: input.metadata,
      });
    }
  }

  const commissionAmount = input.providerOwnerUserId === SYSTEM_USER_ID ? split.totalCost : split.commissionAmount;
  let commissionCredit = debit;
  if (commissionAmount > 0) {
    commissionCredit = applyWalletTransaction({
      walletId: "wallet-platform", counterpartyWalletId: debit.wallet.id,
      direction: "credit", amount: commissionAmount,
      reason: input.providerOwnerUserId === SYSTEM_USER_ID ? "Platform revenue (system-owned provider)" : "Platform commission",
      reasonCode: input.providerOwnerUserId === SYSTEM_USER_ID ? "consumption" : "commission",
      usageHistoryId: input.usageHistoryId, marketplaceListingId: input.marketplaceListingId,
      idempotencyKey: `${idemBase}-commission`, metadata: input.metadata,
    });
  }

  return { debit, providerCredit, commissionCredit, split, insufficientBalance: insufficient };
}

export function enforceConsumerBalance(consumerUserId: string, estimatedCostUsd: number): boolean {
  if (!consumerUserId || consumerUserId === SYSTEM_USER_ID) return true;
  const wallet = getWalletForUser(consumerUserId);
  if (!wallet) return true;
  return wallet.balanceCredits >= estimatedCostUsd;
}
