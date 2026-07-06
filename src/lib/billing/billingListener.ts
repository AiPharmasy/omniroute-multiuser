/**
 * billing/billingListener.ts — Event-driven consumption billing.
 *
 * Subscribes to the usage-recorded-full event from lib/usage/usageEvents.ts
 * and settles the consumer's wallet for each successfully inserted usage row.
 */

import { onUsageRecordedFull, type UsageRecordedFullEvent } from "@/lib/usage/usageEvents";
import { recordConsumption } from "./consumption";
import { isMultiUserModeEnabled, SYSTEM_USER_ID } from "@/lib/db/users";
import { getSettings } from "@/lib/localDb";
import { getProviderConnectionById } from "@/lib/db/providers";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { calculateCost } from "@/lib/usage/costCalculator";

let subscribed = false;

export function initBillingListener(): () => void {
  if (subscribed) return () => {};
  subscribed = true;

  const unsubscribe = onUsageRecordedFull(async (event: UsageRecordedFullEvent) => {
    try {
      await settleConsumption(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[billing] consumption settlement failed for usage_history.id=${event.usageHistoryId}: ${message}`);
    }
  });

  return () => {
    subscribed = false;
    unsubscribe();
  };
}

async function settleConsumption(event: UsageRecordedFullEvent): Promise<void> {
  const settings = await getSettings();
  if (!isMultiUserModeEnabled(settings as never)) return;

  if (!event.success) return;

  if (!event.apiKeyId) return;
  const apiKeyMeta = getApiKeyMetadata(event.apiKeyId);
  if (!apiKeyMeta) return;
  const consumerUserId = apiKeyMeta.ownerUserId ?? SYSTEM_USER_ID;
  if (consumerUserId === SYSTEM_USER_ID) return;

  if (!event.connectionId) return;
  const connection = getProviderConnectionById(event.connectionId);
  if (!connection) return;
  const providerOwnerUserId =
    (connection as any).ownerUserId ?? (connection as any).owner_user_id ?? SYSTEM_USER_ID;

  const totalCostUsd = await calculateCost(
    event.provider ?? "",
    event.model ?? "",
    {
      input: event.tokensInput,
      output: event.tokensOutput,
      cacheRead: Number((event.entry.tokens as any)?.cacheRead ?? 0) || 0,
      cacheCreation: Number((event.entry.tokens as any)?.cacheCreation ?? 0) || 0,
      reasoning: Number((event.entry.tokens as any)?.reasoning ?? 0) || 0,
    },
    { serviceTier: (event.entry.serviceTier as string) ?? undefined }
  );
  if (totalCostUsd <= 0) return;

  recordConsumption({
    consumerUserId,
    providerOwnerUserId,
    totalCostUsd,
    usageHistoryId: event.usageHistoryId,
    marketplaceListingId: (connection as any).marketplaceListingId ?? undefined,
    metadata: {
      provider: event.provider, model: event.model,
      tokensInput: event.tokensInput, tokensOutput: event.tokensOutput,
    },
  });
}
