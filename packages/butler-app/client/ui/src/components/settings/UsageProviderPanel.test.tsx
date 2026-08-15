import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageProviderPanel } from "./UsageProviderPanel";
import type { UsageMonitorView } from "@/app/types.ts";

type Provider = UsageMonitorView["providerUsage"]["providers"][number];

const usage = {
  requestCount: 2,
  promptTokens: 10,
  cachedTokens: 1,
  uncachedTokens: 9,
  outputTokens: 4,
  totalTokens: 14,
  missingTotalTokenCount: 0,
  providerId: "openai",
  source: "local_telemetry" as const,
  billing: { available: false, reason: "미지원" },
};

function provider(remaining: Provider["remaining"]): Provider {
  return { ...usage, remaining };
}

test("usage provider panel renders fresh, stale, unavailable, and partial states", () => {
  const markup = renderToStaticMarkup(
    <UsageProviderPanel
      activeProviderId="openai"
      providers={[
        provider({
          available: true,
          stale: false,
          sourceKind: "codex_app_server",
          sourceId: "openai-codex-rate-limits",
          planKind: "subscription",
          planName: "Pro",
          windows: [{
            id: "tokens-5-hour",
            usedPercent: 10,
            remainingPercent: 90,
            windowDurationMins: 300,
            resetsAt: "2026-08-09T01:00:00.000Z",
            expiresAt: null,
          }, {
            id: "unknown-window",
            usedPercent: null,
            remainingPercent: null,
            windowDurationMins: null,
            resetsAt: null,
            expiresAt: null,
          }],
          fetchedAt: "2026-08-09T00:00:00.000Z",
          reason: null,
        }),
        {
          ...provider({
            available: true,
            stale: true,
            sourceKind: "codex_app_server",
            sourceId: "openai-codex-rate-limits",
            planKind: "subscription",
            planName: "Pro",
            windows: [{
              id: "tokens-weekly",
              usedPercent: 55,
              remainingPercent: 45,
              windowDurationMins: 10080,
              resetsAt: "2026-08-10T01:00:00.000Z",
              expiresAt: null,
            }],
            fetchedAt: "2026-08-08T00:00:00.000Z",
            reason: {
              code: "provider_timeout",
              message: "새로고침 실패",
            },
          }),
          providerId: "anthropic",
        },
        {
          ...provider({
            available: false,
            stale: false,
            sourceKind: "provider_quota",
            sourceId: "anthropic-unsupported",
            planKind: "unknown",
            planName: null,
            windows: [],
            fetchedAt: null,
            reason: {
              code: "provider_quota_surface_unavailable",
              message: "공식 잔여량 표면 없음",
            },
          }),
          providerId: "zai",
        },
      ]}
    />,
  );

  expect(markup).toContain("90% 남음");
  expect(markup).toContain("45% 남음");
  expect(markup).toContain("미확인");
  expect(markup).toContain("5시간 한도");
  expect(markup).toContain("주간 한도");
  expect(markup.match(/role="progressbar"/g)).toHaveLength(2);
  expect(markup).toContain('aria-valuenow="90"');
  expect(markup).toContain('aria-valuenow="45"');
  expect(markup).toContain('aria-label="5시간 한도: 90% 남음"');
  expect(markup).toContain('aria-label="주간 한도: 45% 남음"');
  expect(markup).toContain("재설정");
  expect(markup).toContain("OpenAI Codex 공식 사용량");
  expect(markup).toContain("공식 잔여량 조회를 지원하지 않습니다.");
  expect(markup.match(/공식 잔여량 조회를 지원하지 않습니다\./g)).toHaveLength(1);
  expect(markup).toContain("프로바이더 사용량 응답 시간이 초과되었습니다.");
  expect(markup).toContain("이전 확인값");
  expect(markup).not.toContain("provider_timeout");
  expect(markup).not.toContain("openai-codex-rate-limits");
  expect(markup).not.toContain("anthropic-unsupported");
  expect(markup).not.toContain("잔여량: 확인됨");
  expect(markup).not.toContain('aria-valuenow="0"');
  expect(markup).not.toContain("300분 창");
});
