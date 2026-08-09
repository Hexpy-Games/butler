import type {
  ProviderQuotaReasonCode,
  ProviderQuotaResultView,
} from "@/app/types.ts";

export function windowLabel(
  window: ProviderQuotaResultView["windows"][number],
): string {
  if (window.id === "mcp-month") return "MCP 월간 한도";
  if (window.id === "tokens-5-hour" || window.id.startsWith("tokens-5-hour-")) {
    return "5시간 한도";
  }
  if (window.id === "tokens-weekly" || window.id.startsWith("tokens-weekly-")) {
    return "주간 한도";
  }
  if (window.windowDurationMins !== null) {
    return `${window.windowDurationMins}분 한도`;
  }
  return window.id === "individualLimit" ? "개별 한도" : "제공된 한도";
}

export function planLabel(
  kind: ProviderQuotaResultView["planKind"],
  name: string | null,
): string {
  if (name) return name;
  if (kind === "subscription") return "구독";
  if (kind === "api") return "API 사용량";
  return "확인되지 않음";
}

export function sourceLabel(
  kind: ProviderQuotaResultView["sourceKind"],
): string {
  if (kind === "codex_app_server") return "OpenAI Codex 공식 사용량";
  if (kind === "zai_usage_query") return "Z.AI Coding Plan 공식 사용량";
  return "공식 프로바이더 사용량";
}

export function quotaReasonLabel(
  code: ProviderQuotaReasonCode | undefined,
): string {
  switch (code) {
    case "provider_auth_not_applicable":
      return "API 키에는 Codex 구독 잔여량이 적용되지 않습니다.";
    case "provider_auth_required":
      return "OpenAI Codex 구독 인증이 필요합니다.";
    case "provider_auth_surface_mismatch":
      return "Codex 구독 인증 방식을 사용할 수 없습니다.";
    case "provider_auth_failure":
      return "OpenAI Codex 인증을 확인하지 못했습니다.";
    case "provider_executable_unavailable":
      return "Codex 실행 파일을 확인할 수 없습니다.";
    case "provider_timeout":
      return "프로바이더 사용량 응답 시간이 초과되었습니다.";
    case "provider_response_malformed":
      return "프로바이더 사용량 응답을 읽을 수 없습니다.";
    case "provider_rpc_failure":
      return "프로바이더 사용량 조회에 실패했습니다.";
    case "provider_temporary_failure":
      return "프로바이더 사용량을 잠시 확인할 수 없습니다.";
    case "provider_quota_surface_unavailable":
      return "공식 잔여량 조회를 지원하지 않습니다.";
    default:
      return "프로바이더 잔여량을 확인할 수 없습니다.";
  }
}

export function formatRemaining(value: number | null): string {
  if (value === null) return "미확인";
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

export function formatQuotaTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "미확인";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
