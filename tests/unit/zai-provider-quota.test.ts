import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZaiQuotaAdapter } from
  "../../packages/butler-agent/src/integrations/providers/zai/provider-quota.ts";
import { mapZaiQuotaResponse } from
  "../../packages/butler-agent/src/integrations/providers/zai/zai-quota-response.ts";
import { registerHostedModelConfig } from
  "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import { ProviderQuotaMonitor } from
  "../../packages/butler-agent/src/operations/metrics/provider-quota.ts";

function tempButlerData(): string {
  return mkdtempSync(join(tmpdir(), "butler-zai-quota-"));
}

function registerZai(data: string, apiBaseUrl?: string): void {
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-coding-secret",
    apiBaseUrl,
  }, data);
}

function quotaPayload(): Record<string, unknown> {
  return {
    data: {
      level: "pro",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 37,
          nextResetTime: 1_700_000_000_000,
        },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 1,
          percentage: 140,
          nextResetTime: 1_750_000_000_000,
          usageDetails: { secret: "weekly-raw-detail" },
        },
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          percentage: 12,
          currentValue: 12,
          usage: 100,
          nextResetTime: 1_800_000_000_000,
          resetId: "undocumented-reset",
          usageDetails: { secret: "raw-detail" },
        },
      ],
    },
  };
}

test("Z.AI mapper keeps documented token/MCP semantics and excludes reset guesses", () => {
  const result = mapZaiQuotaResponse(quotaPayload());
  expect(result).toMatchObject({
    available: true,
    sourceKind: "zai_usage_query",
    sourceId: "zai-coding-plan-usage-query",
    planKind: "subscription",
    planName: "pro",
    windows: [
      {
        id: "tokens-5-hour",
        usedPercent: 37,
        remainingPercent: 63,
        windowDurationMins: 300,
        resetsAt: "2023-11-14T22:13:20.000Z",
      },
      {
        id: "tokens-weekly",
        usedPercent: 100,
        remainingPercent: 0,
        windowDurationMins: 10080,
        resetsAt: "2025-06-15T15:06:40.000Z",
      },
      {
        id: "mcp-month",
        usedPercent: 12,
        remainingPercent: 88,
        windowDurationMins: null,
        resetsAt: "2027-01-15T08:00:00.000Z",
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("undocumented-reset");
  expect(JSON.stringify(result)).not.toContain("raw-detail");
});

test("Z.AI mapper ignores unknown limit discriminators without guessing windows", () => {
  const payload = {
    data: {
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25 },
        { type: "TOKENS_LIMIT", unit: 99, number: 1, percentage: 30 },
        { type: "TIME_LIMIT", unit: 7, number: 1, percentage: 10 },
      ],
    },
  };
  expect(mapZaiQuotaResponse(payload)?.windows).toEqual([
    expect.objectContaining({
      id: "tokens-5-hour",
      windowDurationMins: 300,
    }),
  ]);
  expect(mapZaiQuotaResponse({
    data: {
      level: "pro",
      limits: [{ type: "TOKENS_LIMIT", unit: 99, number: 1, percentage: 30 }],
    },
  })).toBeNull();
  expect(mapZaiQuotaResponse({
    data: {
      level: "pro",
      limits: [{
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 25,
        nextResetTime: 1_700_000_000,
      }],
    },
  })?.windows[0]?.resetsAt).toBeNull();
});

test("Z.AI mapper accepts the official data envelope without requiring success", () => {
  const result = mapZaiQuotaResponse(quotaPayload());
  expect(result?.available).toBe(true);
  expect(mapZaiQuotaResponse({ success: false, ...quotaPayload() })).toBeNull();
  expect(mapZaiQuotaResponse({
    data: { ...quotaPayload().data as Record<string, unknown>, level: "team" },
  })).toBeNull();
  expect(mapZaiQuotaResponse({ data: { limits: [{ type: "TOKENS_LIMIT" }] } })).toBeNull();
});

test("Z.AI adapter uses the registered Coding Plan credential and official quota URL", async () => {
  const data = tempButlerData();
  const otherData = tempButlerData();
  const previousButlerData = process.env.BUTLER_DATA;
  try {
    registerZai(data);
    registerZai(otherData, "https://api.z.ai/api/paas/v4");
    process.env.BUTLER_DATA = otherData;
    let request: { url: string; authorization: string } | null = null;
    const result = await createZaiQuotaAdapter({
      butlerData: data,
      fetchImpl: async (input, init) => {
        request = {
          url: String(input),
          authorization: String(new Headers(init?.headers).get("authorization")),
        };
        return new Response(JSON.stringify(quotaPayload()), { status: 200 });
      },
    }).read();
    expect(request as { url: string; authorization: string } | null).toEqual({
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      authorization: "zai-coding-secret",
    });
    expect(result.available).toBe(true);
    expect(JSON.stringify(result)).not.toContain("zai-coding-secret");
  } finally {
    if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousButlerData;
    rmSync(data, { recursive: true, force: true });
    rmSync(otherData, { recursive: true, force: true });
  }
});

test("Z.AI adapter rejects missing/wrong-surface auth without a network call", async () => {
  const missingData = tempButlerData();
  const wrongData = tempButlerData();
  try {
    let called = false;
    const missing = await createZaiQuotaAdapter({
      butlerData: missingData,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    }).read();
    expect(missing.reason?.code).toBe("provider_auth_required");
    expect(called).toBe(false);

    registerZai(wrongData, "https://api.z.ai/api/paas/v4");
    const mismatch = await createZaiQuotaAdapter({
      butlerData: wrongData,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    }).read();
    expect(mismatch.reason?.code).toBe("provider_auth_surface_mismatch");
    expect(called).toBe(false);
  } finally {
    rmSync(missingData, { recursive: true, force: true });
    rmSync(wrongData, { recursive: true, force: true });
  }
});

test("Z.AI adapter isolates auth, malformed, and oversized responses", async () => {
  const data = tempButlerData();
  try {
    registerZai(data);
    const authFailure = await createZaiQuotaAdapter({
      butlerData: data,
      fetchImpl: async () => new Response(JSON.stringify({ secret: "raw-error" }), { status: 401 }),
    }).read();
    expect(authFailure.reason?.code).toBe("provider_auth_failure");
    expect(JSON.stringify(authFailure)).not.toContain("raw-error");

    const malformed = await createZaiQuotaAdapter({
      butlerData: data,
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    }).read();
    expect(malformed.reason?.code).toBe("provider_response_malformed");

    const unsupported = await createZaiQuotaAdapter({
      butlerData: data,
      fetchImpl: async () => new Response(JSON.stringify({
        data: { ...quotaPayload().data as Record<string, unknown>, level: "team" },
      }), { status: 200 }),
    }).read();
    expect(unsupported.reason?.code).toBe("provider_quota_surface_unavailable");

    const oversized = await createZaiQuotaAdapter({
      butlerData: data,
      maxOutputBytes: 256,
      fetchImpl: async () => new Response("x".repeat(4_096), { status: 200 }),
    }).read();
    expect(oversized.reason?.code).toBe("provider_response_malformed");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("Z.AI auth HTTP failures clear stale quota even with oversized error bodies", async () => {
  const data = tempButlerData();
  let authFailure = false;
  try {
    registerZai(data);
    const adapter = createZaiQuotaAdapter({
      butlerData: data,
      fetchImpl: async () => authFailure
        ? new Response("secret-error-body".repeat(8_000), { status: 401 })
        : new Response(JSON.stringify(quotaPayload()), { status: 200 }),
    });
    const monitor = new ProviderQuotaMonitor({ adapters: [adapter] });
    expect((await monitor.refreshProvider("zai")).available).toBe(true);
    authFailure = true;
    expect(await monitor.refreshProvider("zai")).toMatchObject({
      available: false,
      stale: false,
      windows: [],
      reason: { code: "provider_auth_failure" },
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("Z.AI quota reads are bounded by the named timeout", async () => {
  const data = tempButlerData();
  try {
    registerZai(data);
    const result = await createZaiQuotaAdapter({
      butlerData: data,
      timeoutMs: 10,
      fetchImpl: async () => await new Promise<Response>(() => undefined),
    }).read();
    expect(result.reason?.code).toBe("provider_timeout");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
