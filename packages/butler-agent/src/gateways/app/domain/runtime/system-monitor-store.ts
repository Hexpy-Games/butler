import { readUsageMonitor } from "../../../../operations/metrics/usage-monitor.ts";
import {
  unavailableProviderQuota,
  type ProviderQuotaMonitor,
} from "../../../../operations/metrics/provider-quota.ts";
import { systemEventsForButlerData } from "./system-events-read-model.ts";
import { paginationInput } from "../sessions/session-read-model.ts";
import type { SystemEventListView, UsageMonitorView } from "../../interface/protocol/app-protocol.ts";

export class AppSystemMonitorStore {
  private readonly providerQuotaMonitor: ProviderQuotaMonitor;

  constructor(
    private readonly butlerData: string,
    providerQuotaMonitor: ProviderQuotaMonitor,
  ) {
    this.providerQuotaMonitor = providerQuotaMonitor;
  }

  listSystemEvents(
    options: { limit?: number; offset?: number } = {},
  ): SystemEventListView {
    const page = paginationInput(options);
    const events = systemEventsForButlerData(this.butlerData);
    return {
      events: events.slice(page.offset, page.offset + page.limit),
      pagination: {
        ...page,
        total: events.length,
        has_more: page.offset + page.limit < events.length,
      },
      generated_at: new Date().toISOString(),
      raw_text_included: false,
    };
  }

  getUsageMonitor(
    options: { sessionId?: string; sinceTs?: number | null } = {},
  ): Promise<UsageMonitorView> {
    const local = readUsageMonitor({
      butlerData: this.butlerData,
      sessionId: options.sessionId,
      sinceTs: options.sinceTs ?? null,
    });
    return this.mergeProviderQuota(local);
  }

  private async mergeProviderQuota(
    local: ReturnType<typeof readUsageMonitor>,
  ): Promise<UsageMonitorView> {
    const providerIds = local.providerUsage.providers.map((provider) => provider.providerId);
    const quotaByProvider = await this.providerQuotaMonitor.refresh(providerIds);
    return {
      ...local,
      providerUsage: {
        ...local.providerUsage,
        providers: local.providerUsage.providers.map((provider) => ({
          ...provider,
          remaining: quotaByProvider.get(provider.providerId) ?? unavailableProviderQuota({
            code: "provider_quota_surface_unavailable",
            message: "No provider quota result was returned.",
          }),
        })),
      },
      generated_at: new Date().toISOString(),
      raw_text_included: false,
    };
  }
}
