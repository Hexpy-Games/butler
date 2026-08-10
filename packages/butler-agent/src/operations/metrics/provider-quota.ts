/**
 * Provider-owned subscription/quota projections.
 *
 * This module deliberately contains no credential or persistence code. Adapters
 * return a sanitized result and this monitor owns isolation, stale fallback,
 * and same-provider in-flight de-duplication.
 */

export type ProviderQuotaPlanKind = "subscription" | "api" | "unknown";
export type ProviderQuotaSourceKind =
  | "codex_app_server"
  | "zai_usage_query"
  | "provider_quota";

export type ProviderQuotaReasonCode =
  | "provider_quota_surface_unavailable"
  | "provider_auth_not_applicable"
  | "provider_auth_required"
  | "provider_auth_surface_mismatch"
  | "provider_executable_unavailable"
  | "provider_timeout"
  | "provider_response_malformed"
  | "provider_auth_failure"
  | "provider_rpc_failure"
  | "provider_temporary_failure";

export interface ProviderQuotaReason {
  code: ProviderQuotaReasonCode;
  message: string;
}

export interface ProviderQuotaWindow {
  id: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
  expiresAt: string | null;
}

export interface ProviderQuotaResult {
  available: boolean;
  stale: boolean;
  sourceKind: ProviderQuotaSourceKind;
  sourceId: string;
  planKind: ProviderQuotaPlanKind;
  planName: string | null;
  windows: ProviderQuotaWindow[];
  fetchedAt: string | null;
  reason: ProviderQuotaReason | null;
}

export interface ProviderQuotaAdapter {
  readonly providerId: string;
  read(): Promise<ProviderQuotaResult>;
}

export interface ProviderQuotaMonitorOptions {
  adapters?: readonly ProviderQuotaAdapter[];
}

const unsupportedReason = (): ProviderQuotaReason => ({
  code: "provider_quota_surface_unavailable",
  message: "No stable official quota surface is available for this provider.",
});

export function unavailableProviderQuota(
  reason: ProviderQuotaReason,
  source: { kind?: ProviderQuotaSourceKind; id?: string } = {},
): ProviderQuotaResult {
  return {
    available: false,
    stale: false,
    sourceKind: source.kind ?? "provider_quota",
    sourceId: source.id ?? "unavailable",
    planKind: "unknown",
    planName: null,
    windows: [],
    fetchedAt: null,
    reason,
  };
}

function temporaryFailure(): ProviderQuotaReason {
  return {
    code: "provider_temporary_failure",
    message: "The provider quota read failed temporarily.",
  };
}

function allowsStaleFallback(reason: ProviderQuotaReason | null): boolean {
  return reason?.code === "provider_executable_unavailable" ||
    reason?.code === "provider_timeout" ||
    reason?.code === "provider_response_malformed" ||
    reason?.code === "provider_rpc_failure" ||
    reason?.code === "provider_temporary_failure";
}

function providerFailureResult(
  result: ProviderQuotaResult,
): ProviderQuotaResult {
  return {
    ...result,
    available: false,
    stale: false,
    windows: [],
    fetchedAt: null,
    planKind: "unknown",
    planName: null,
  };
}

export class ProviderQuotaMonitor {
  private readonly adapters: Map<string, ProviderQuotaAdapter>;
  private readonly lastKnownGood = new Map<string, ProviderQuotaResult>();
  private readonly inFlight = new Map<string, Promise<ProviderQuotaResult>>();

  constructor(options: ProviderQuotaMonitorOptions = {}) {
    this.adapters = new Map(
      (options.adapters ?? []).map((adapter) => [adapter.providerId, adapter]),
    );
  }

  async refresh(providerIds: readonly string[]): Promise<Map<string, ProviderQuotaResult>> {
    const uniqueProviderIds = Array.from(new Set(providerIds));
    const entries = await Promise.all(
      uniqueProviderIds.map(async (providerId) => [
        providerId,
        await this.refreshProvider(providerId),
      ] as const),
    );
    return new Map(entries);
  }

  async refreshProvider(providerId: string): Promise<ProviderQuotaResult> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return unavailableProviderQuota(unsupportedReason(), {
        kind: "provider_quota",
        id: `${providerId}-unsupported`,
      });
    }

    const existing = this.inFlight.get(providerId);
    if (existing) return await existing;

    const operation = this.readAdapter(providerId, adapter);
    this.inFlight.set(providerId, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(providerId) === operation) {
        this.inFlight.delete(providerId);
      }
    }
  }

  private async readAdapter(
    providerId: string,
    adapter: ProviderQuotaAdapter,
  ): Promise<ProviderQuotaResult> {
    let result: ProviderQuotaResult;
    try {
      result = await adapter.read();
    } catch {
      result = unavailableProviderQuota(temporaryFailure(), {
        kind: "provider_quota",
        id: `${providerId}-read`,
      });
    }

    if (result.available) {
      const fresh: ProviderQuotaResult = {
        ...result,
        stale: false,
        fetchedAt: result.fetchedAt ?? new Date().toISOString(),
        reason: result.reason,
      };
      this.lastKnownGood.set(providerId, fresh);
      return fresh;
    }

    const cached = this.lastKnownGood.get(providerId);
    if (cached && allowsStaleFallback(result.reason)) {
      return {
        ...cached,
        stale: true,
        reason: result.reason,
      };
    }
    if (!allowsStaleFallback(result.reason)) this.lastKnownGood.delete(providerId);
    return providerFailureResult(result);
  }
}

export function createProviderQuotaMonitor(
  options: ProviderQuotaMonitorOptions = {},
): ProviderQuotaMonitor {
  return new ProviderQuotaMonitor(options);
}
