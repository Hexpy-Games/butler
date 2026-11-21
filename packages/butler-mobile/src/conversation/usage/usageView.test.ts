// test-category: pure-logic
import { expect, test } from "bun:test";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import type { ModelSummary, UsageMonitorView } from "../../../../butler-protocol/src/index.ts";
import { compactTokens } from "../../../../butler-app/client/ui/src/components/usage/compactTokens.ts";
import { usageAuthMode, usageParts } from "./usageView";

test("usageParts splits conversation and delegated tokens", () => {
  const view: UsageMonitorView = {
    timeline: { slotMinutes: 15, slots: [] },
    filters: { sessionId: null, sinceTs: null, untilTs: null },
    model: { requestCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 1000,
      subtasks: { requestCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 400 } },
    providerUsage: { activeProviderId: null, providers: [] },
    cost: { available: false, estimatedUsd: null },
    generated_at: "",
  };
  const parts = usageParts(view, getAppCopy("en-US"), "en-US");
  expect(parts).toHaveLength(2);
  expect(parts![0].value.startsWith(compactTokens(600, "en-US"))).toBe(true);
  expect(parts![1].value.startsWith(compactTokens(400, "en-US"))).toBe(true);
});

test("usageAuthMode follows local platform and provider authentication", () => {
  expect(usageAuthMode({ provider_id: "local" } as ModelSummary, undefined)).toBe("local");
  expect(usageAuthMode({ auth_type: "chatgpt_oauth" } as ModelSummary, undefined)).toBe("subscription");
  expect(usageAuthMode({ auth_type: "api_key" } as ModelSummary, undefined)).toBe("api_key");
  expect(usageAuthMode(undefined, undefined)).toBe("unknown");
});
