import { appCopy } from "@/app/copy.ts";
import type {
  ProviderQuotaReasonCode,
  ProviderQuotaResultView,
} from "@/app/types.ts";

export function windowLabel(
  window: ProviderQuotaResultView["windows"][number],
): string {
  if (window.id === "mcp-month") return appCopy.interfaceStatus.mcpMonthly;
  if (window.id === "tokens-5-hour" || window.id.startsWith("tokens-5-hour-")) {
    return appCopy.interfaceStatus.fiveHour;
  }
  if (window.id === "tokens-weekly" || window.id.startsWith("tokens-weekly-")) {
    return appCopy.interfaceStatus.weekly;
  }
  if (window.windowDurationMins !== null) {
    return appCopy.interfaceStatus.minutesLimit(window.windowDurationMins);
  }
  return window.id === "individualLimit" ? appCopy.interfaceStatus.individual : appCopy.interfaceStatus.providedLimit;
}

export function planLabel(
  kind: ProviderQuotaResultView["planKind"],
  name: string | null,
): string {
  if (name) return name;
  if (kind === "subscription") return appCopy.interfaceStatus.subscription;
  if (kind === "api") return appCopy.interfaceStatus.apiUsage;
  return appCopy.interfaceStatus.unconfirmed;
}

export function sourceLabel(
  kind: ProviderQuotaResultView["sourceKind"],
): string {
  if (kind === "codex_app_server") return appCopy.interfaceStatus.codexUsage;
  if (kind === "zai_usage_query") return appCopy.interfaceStatus.zaiUsage;
  return appCopy.interfaceStatus.providerUsage;
}

export function quotaReasonLabel(
  code: ProviderQuotaReasonCode | undefined,
): string {
  switch (code) {
    case "provider_auth_not_applicable":
      return appCopy.interfaceStatus.authNotApplicable;
    case "provider_auth_required":
      return appCopy.interfaceStatus.authRequired;
    case "provider_auth_surface_mismatch":
      return appCopy.interfaceStatus.authMismatch;
    case "provider_auth_failure":
      return appCopy.interfaceStatus.authFailure;
    case "provider_executable_unavailable":
      return appCopy.interfaceStatus.executableUnavailable;
    case "provider_timeout":
      return appCopy.interfaceStatus.quotaTimeout;
    case "provider_response_malformed":
      return appCopy.interfaceStatus.quotaMalformed;
    case "provider_rpc_failure":
      return appCopy.interfaceStatus.quotaFailure;
    case "provider_temporary_failure":
      return appCopy.interfaceStatus.quotaTemporary;
    case "provider_quota_surface_unavailable":
      return appCopy.interfaceStatus.quotaUnsupported;
    default:
      return appCopy.interfaceStatus.quotaUnknown;
  }
}

export function formatRemaining(value: number | null): string {
  if (value === null) return appCopy.interfaceStatus.unknown;
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

export function formatQuotaTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return appCopy.interfaceStatus.unknown;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
