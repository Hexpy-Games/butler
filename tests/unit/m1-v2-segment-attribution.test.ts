import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeM1ProviderAttempt,
  recordM1ResponseUsage,
} from "../../packages/butler-agent/src/integrations/providers/shared/m1-segment-attribution.ts";
import { createOpenAIResponse } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { toolResultToMessage } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-result-message.ts";
import { createToolResultModelPreviewContext } from
  "../../packages/butler-agent/src/agent/tools/tool-result-serialization.ts";

describe("M1 v2 provider-send segment attribution", () => {
  test("keeps result, recovery, memory, source, and exact-view kinds distinct", () => {
    const context = createToolResultModelPreviewContext();
    const kind = (name: string, ok = true) => toolResultToMessage({
      result: { toolCallId: name, name, ok, ...(ok ? { output: {} } : { error: "rejected" }) },
      modelPreviewContext: context,
    }).requestSegmentKind;
    expect(kind("read_file")).toBe("latest_tool_result_delivery");
    expect(kind("project_ledger_work_complete", false)).toBe("work_recovery_receipt");
    expect(kind("recall_memory")).toBe("memory_recall_context");
    expect(kind("web_search")).toBe("source_reference");
    expect(kind("read_operation_results")).toBe("exact_result_view");
  });

  test("is default-off and preserves the exact JSON request", () => {
    const body = { model: "gpt-5.6-sol", input: "안녕 🌍" };
    const observed = observeM1ProviderAttempt({
      providerId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      body,
      routeTransportAttemptOrdinal: 0,
      providerRetryOrdinal: 0,
      roundIndex: 0,
      env: {},
    });
    expect(observed.serializedRequest).toBe(JSON.stringify(body));
    expect(observed.observation).toBeNull();
  });

  test("partitions every final UTF-8 byte exactly once without raw content", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-test-"));
    const body = {
      model: "gpt-5.6-sol",
      instructions: "stable rules",
      input: "안녕 🌍",
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    };
    const observed = observeM1ProviderAttempt({
      providerId: "openai-codex",
      modelRef: "openai/gpt-5.6-sol",
      body,
      turnId: "turn-private-value",
      phase: "guided",
      roundIndex: 2,
      routeTransportAttemptOrdinal: 0,
      providerRetryOrdinal: 1,
      segmentManifest: [
        { path: ["instructions"], kind: "stable_btcc_protocol", stability: "stable" },
        { path: ["input"], kind: "current_user_request", stability: "dynamic" },
      ],
      butlerData,
      env: { BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on" },
    });
    const observation = observed.observation!;
    expect(observation.envelope.providerSendBytes).toBe(
      Buffer.byteLength(JSON.stringify(body), "utf8"),
    );
    expect(observation.segments.reduce((sum, row) => sum + row.providerSendBytes, 0))
      .toBe(observation.envelope.providerSendBytes);
    expect(new Set(observation.segments.map((row) => row.segmentId)).size)
      .toBe(observation.segments.length);
    expect(observation.segments.some((row) => row.kind === "tool_schema")).toBe(true);
    expect(observation.segments.some((row) => row.kind === "provider_carrier_overhead")).toBe(true);

    const stored = readFileSync(join(butlerData, "metrics", "operational-events.jsonl"), "utf8");
    expect(stored).not.toContain("안녕");
    expect(stored).not.toContain("turn-private-value");
    expect(stored).not.toContain("read_file");
  });

  test("attributes path-bound spans inside cumulative provider input", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-cumulative-"));
    const observed = observeM1ProviderAttempt({
      providerId: "openai-codex",
      modelRef: "openai/gpt-5.6-sol",
      body: { input: [
        { role: "user", content: [{ type: "input_text", text: "request work" }] },
        { type: "function_call_output", output: "tool-result" },
      ] },
      roundIndex: 1,
      routeTransportAttemptOrdinal: 0,
      providerRetryOrdinal: 0,
      segmentManifest: [
        { path: ["input", 0, "content", 0, "text"], kind: "current_user_request",
          stability: "dynamic", startUtf16: 0, endUtf16: 8 },
        { path: ["input", 0, "content", 0, "text"],
          kind: "project_ledger_and_work_authority", stability: "dynamic",
          startUtf16: 8, endUtf16: 12 },
        { path: ["input", 1, "output"], kind: "latest_tool_result_delivery",
          stability: "dynamic" },
      ],
      butlerData,
      env: { BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on" },
    }).observation!;
    expect(observed.segments.map((segment) => segment.kind)).toEqual(expect.arrayContaining([
      "current_user_request",
      "project_ledger_and_work_authority",
      "latest_tool_result_delivery",
    ]));
  });

  test("preserves exact JSON bytes across surrogate, escaping, undefined, and array nulls", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-json-edge-"));
    const high = String.fromCharCode(0xd83c);
    const low = String.fromCharCode(0xdf0d);
    const value = `split ${high}${low} \\"\n`;
    const body = { input: value, omitted: undefined, array: [undefined, null, value] };
    const observed = observeM1ProviderAttempt({
      providerId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      body,
      roundIndex: 0,
      routeTransportAttemptOrdinal: 0,
      providerRetryOrdinal: 0,
      segmentManifest: [
        { path: ["input"], kind: "current_user_request", stability: "dynamic",
          startUtf16: 0, endUtf16: `split ${high}`.length },
        { path: ["input"], kind: "memory_recall_context", stability: "dynamic",
          startUtf16: `split ${high}`.length, endUtf16: value.length },
      ],
      butlerData,
      env: { BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on" },
    });
    expect(observed.serializedRequest).toBe(JSON.stringify(body));
    expect(observed.observation).not.toBeNull();
    expect(observed.observation!.segments.reduce((sum, row) => sum + row.providerSendBytes, 0))
      .toBe(Buffer.byteLength(JSON.stringify(body), "utf8"));
  });

  test("keeps an exact observation when custom JSON serialization needs fallback", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-to-json-"));
    const body = { input: { toJSON: () => "provider-normalized" } };
    const observed = observeM1ProviderAttempt({
      providerId: "openai", modelRef: "openai/gpt-5.6-sol", body,
      roundIndex: 0, routeTransportAttemptOrdinal: 0, providerRetryOrdinal: 0, butlerData,
      env: {
        BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on",
        BUTLER_M1_BASELINE_ELIGIBILITY: "cache_mismatch",
      },
    });
    expect(observed.observation).not.toBeNull();
    expect(observed.observation!.envelope.eligibility).toBe("eligible");
    expect(observed.observation!.segments).toHaveLength(1);
    expect(observed.observation!.segments[0]?.kind).toBe("other_typed_context");
    expect(observed.observation!.segments[0]?.providerSendBytes)
      .toBe(Buffer.byteLength(JSON.stringify(body), "utf8"));
  });

  test("uses exact JSON paths for duplicate string values", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-duplicate-"));
    const observed = observeM1ProviderAttempt({
      providerId: "openai", modelRef: "openai/gpt-5.6-sol",
      body: { input: [
        { role: "user", content: [{ type: "input_text", text: "same" }] },
        { role: "user", content: [{ type: "input_text", text: "same" }] },
      ] },
      roundIndex: 0, routeTransportAttemptOrdinal: 0, providerRetryOrdinal: 0, butlerData,
      segmentManifest: [
        { path: ["input", 0, "content", 0, "text"], kind: "current_user_request",
          stability: "dynamic" },
        { path: ["input", 1, "content", 0, "text"], kind: "memory_recall_context",
          stability: "dynamic" },
      ],
      env: { BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on" },
    }).observation!;
    expect(observed.segments.find((row) => row.kind === "current_user_request")?.providerSendBytes)
      .toBeGreaterThan(0);
    expect(observed.segments.find((row) => row.kind === "memory_recall_context")?.providerSendBytes)
      .toBeGreaterThan(0);
  });

  test("repairs key permissions and refuses an invalid installation key", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-key-"));
    const metrics = join(butlerData, "metrics");
    const keyPath = join(metrics, ".m1-v2-attribution.key");
    mkdirSync(metrics);
    writeFileSync(keyPath, "invalid");
    chmodSync(keyPath, 0o644);
    const rejected = observeM1ProviderAttempt({
      providerId: "openai", modelRef: "openai/gpt-5.6-sol", body: { input: "x" },
      roundIndex: 0, routeTransportAttemptOrdinal: 0, providerRetryOrdinal: 0, butlerData,
      env: { BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on" },
    });
    expect(rejected.observation).toBeNull();
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  test("publishes one complete installation key across concurrent processes", async () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-key-race-"));
    const moduleUrl = new URL(
      "../../packages/butler-agent/src/integrations/providers/shared/m1-segment-attribution.ts",
      import.meta.url,
    ).href;
    const script = `const {observeM1ProviderAttempt}=await import(${JSON.stringify(moduleUrl)});` +
      "const result=observeM1ProviderAttempt({providerId:\"openai\",modelRef:\"openai/gpt\"," +
      "body:{input:\"x\"},roundIndex:0,routeTransportAttemptOrdinal:0,providerRetryOrdinal:0," +
      "butlerData:process.env.BUTLER_DATA,env:process.env});process.exit(result.observation?0:1);";
    const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, BUTLER_DATA: butlerData, BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on" },
      stdout: "ignore",
      stderr: "pipe",
    }));
    expect(await Promise.all(children.map((child) => child.exited)))
      .toEqual(Array.from({ length: 8 }, () => 0));
    const metrics = join(butlerData, "metrics");
    const keyPath = join(metrics, ".m1-v2-attribution.key");
    expect(readFileSync(keyPath, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(metrics).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("keeps physical retries distinct and provider usage nullable", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-retry-"));
    const base = {
      providerId: "openai" as const,
      modelRef: "openai/gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "안녕 🌍" },
      roundIndex: 4,
      routeTransportAttemptOrdinal: 0,
      providerRetryOrdinal: 0,
      segmentManifest: [
        { path: ["input"], kind: "current_user_request", stability: "dynamic" },
      ] as const,
      butlerData,
      env: { BUTLER_M1_V2_SEGMENT_ATTRIBUTION: "on" },
    };
    const first = observeM1ProviderAttempt({ ...base }).observation!;
    const second = observeM1ProviderAttempt({ ...base, providerRetryOrdinal: 1 }).observation!;
    expect(first.envelope.attemptDigest).not.toBe(second.envelope.attemptDigest);
    const redispatch = observeM1ProviderAttempt({ ...base }).observation!;
    expect(redispatch.envelope.attemptDigest).not.toBe(first.envelope.attemptDigest);

    recordM1ResponseUsage({
      attemptDigest: second.envelope.attemptDigest,
      response: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } },
      butlerData,
      env: base.env,
    });
    const stored = readFileSync(join(butlerData, "metrics", "operational-events.jsonl"), "utf8");
    expect(stored).toContain('"promptTokens":12');
    expect(stored).toContain('"cacheReadTokens":null');
    expect(stored).toContain('"reasoningTokens":null');
  });

  test("records each physical retry at the real OpenAI fetch boundary", async () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-fetch-"));
    const originalFetch = globalThis.fetch;
    const previousFlag = process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
    const previousData = process.env.BUTLER_DATA;
    let calls = 0;
    process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = "on";
    process.env.BUTLER_DATA = butlerData;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "retry" } }), { status: 500 });
      }
      return new Response(JSON.stringify({
        id: "response-id",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await createOpenAIResponse(
        { model: "gpt-5.4-mini", input: "hello" },
        undefined,
        { mode: "api_key", authorization: "Bearer test" },
        undefined,
        { roundIndex: 3, butlerData, routeTransportAttemptOrdinal: 2 },
        undefined,
        2,
      );
      const events = readFileSync(
        join(butlerData, "metrics", "operational-events.jsonl"),
        "utf8",
      ).trim().split("\n").map((line) => JSON.parse(line));
      const envelopes = events.filter((event) => event.name === "m1_v2_request_envelope");
      const usages = events.filter((event) => event.name === "m1_v2_response_usage");
      expect(envelopes).toHaveLength(2);
      expect(envelopes.map((event) => event.dimensions.retryOrdinal))
        .toEqual([2_000_000, 2_000_001]);
      expect(envelopes.map((event) => event.dimensions.eligibility))
        .toEqual(["rejected", "retry_contaminated"]);
      expect(new Set(envelopes.map((event) => event.dimensions.attemptDigest)).size).toBe(2);
      expect(usages).toHaveLength(1);
      expect(usages[0]?.dimensions.attemptDigest)
        .toBe(envelopes[1]?.dimensions.attemptDigest);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
      else process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = previousFlag;
      if (previousData === undefined) delete process.env.BUTLER_DATA;
      else process.env.BUTLER_DATA = previousData;
    }
  });

  test("finalizes successful missing usage and typed cache mismatch after fetch", async () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-terminal-"));
    const originalFetch = globalThis.fetch;
    const previousFlag = process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
    process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = "on";
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "response-id", output: [] }), {
      status: 200,
    })) as unknown as typeof fetch;
    try {
      await createOpenAIResponse(
        { model: "gpt-5.4-mini", input: "hello" },
        undefined,
        { mode: "api_key", authorization: "Bearer test" },
        undefined,
        { roundIndex: 0, butlerData, cacheBoundaryEvidence: {
          expectedRevision: "expected", observedRevision: "observed",
        } },
        undefined,
        1,
      );
      const events = readFileSync(join(butlerData, "metrics", "operational-events.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      const envelope = events.find((event) => event.name === "m1_v2_request_envelope");
      const usage = events.find((event) => event.name === "m1_v2_response_usage");
      expect(envelope?.dimensions.eligibility).toBe("cache_mismatch");
      expect(usage?.dimensions.status).toBe("unavailable");
      expect(usage?.dimensions.promptTokens).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
      else process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = previousFlag;
    }
  });

  test("binds official Responses manifests to requestItems paths", async () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-official-rounds-"));
    const originalFetch = globalThis.fetch;
    const previousFlag = process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
    process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = "on";
    const requestBodies: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      call += 1;
      return new Response(JSON.stringify({
        id: `official-${call}`,
        output: call === 1
          ? [{ type: "function_call", call_id: "call-memory", name: "recall_memory", arguments: "{}" }]
          : [],
        usage: { input_tokens: 1, total_tokens: 1 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const base = {
        model: "openai/gpt-5.4-mini", instructions: "stable", tools: [], butlerData,
        requestSegmentSources: { input: [
          { kind: "current_user_request" as const, stability: "dynamic" as const, text: "request" },
        ] },
      };
      const first = await runOpenAIModelRound({
        ...base, messages: [{ role: "user", content: "request" }],
      }, { mode: "api_key", authorization: "Bearer test" });
      await runOpenAIModelRound({
        ...base,
        messages: [
          { role: "user", content: "request" },
          { role: "assistant", content: "assistant-must-not-shift" },
          { role: "tool", toolCallId: "call-memory", content: "memory",
            requestSegmentKind: "memory_recall_context" },
        ],
        continuation: first.continuation,
      }, { mode: "api_key", authorization: "Bearer test" });
      expect(requestBodies.at(-1)?.input).toEqual([{
        type: "function_call_output", call_id: "call-memory", output: "memory",
      }]);
      expect(JSON.stringify(requestBodies.at(-1))).not.toContain("assistant-must-not-shift");
      const events = readFileSync(join(butlerData, "metrics", "operational-events.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      const attempt = events.filter((event) => event.name === "m1_v2_request_envelope")
        .at(-1)?.dimensions.attemptDigest;
      expect(events.some((event) => event.name === "m1_v2_request_segment" &&
        event.dimensions.attemptDigest === attempt &&
        event.dimensions.kind === "memory_recall_context")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
      else process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = previousFlag;
    }
  });

  test("keeps exact carrier paths through cumulative BTCC model rounds", async () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-m1-v2-rounds-"));
    const originalFetch = globalThis.fetch;
    const previousFlag = process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
    process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = "on";
    const requestBodies: Array<Record<string, unknown>> = [];
    let responseIndex = 0;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      responseIndex += 1;
      const toolNames = responseIndex === 1
        ? ["read_file"]
        : responseIndex === 2
          ? ["recall_memory", "web_search", "read_operation_results",
              "project_ledger_work_complete", "read_file"]
          : [];
      const outputItems = [
        ...(responseIndex < 3 ? [{
          type: "message", content: [{ type: "output_text", text: `assistant-${responseIndex}` }],
        }] : [{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
        ...toolNames.map((name, index) => ({
          type: "function_call", call_id: `call-${responseIndex}-${index}`,
          name, arguments: "{}",
        })),
      ];
      const output = outputItems.map((item) =>
        `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
      ).join("");
      const completed = { type: "response.completed", response: {
        id: `response-${responseIndex}`, output: [],
        usage: { input_tokens: 1, total_tokens: 1 },
      } };
      return new Response(`${output}data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const authorization = `Bearer e30.${Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account" },
      })).toString("base64url")}.signature`;
      const auth = { mode: "codex_oauth" as const, authorization };
      const tools = ["read_file", "recall_memory", "web_search", "read_operation_results",
        "project_ledger_work_complete"].map((name) => ({
        name, description: name, parameters: { type: "object", properties: {} },
      }));
      const result = await runBtccAgentLoop({
        prompt: "request",
        model: "openai/gpt-5.6-sol",
        instructions: "stable",
        tools,
        butlerData,
        requestSegmentSources: { input: [
          { kind: "current_user_request" as const, stability: "dynamic" as const, text: "request" },
        ] },
        modelRound: {
          runRound: async (request) =>
            await runOpenAIModelRound(request, auth, "openai/gpt-5.6-sol"),
        },
        executeTool: async (call) => {
          if (call.name === "project_ledger_work_complete") throw new Error("recovery");
          return { value: call.name };
        },
        maxIterations: 4,
      });
      expect(result.finalText).toBe("done");
      const events = readFileSync(join(butlerData, "metrics", "operational-events.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      const envelopes = events.filter((event) => event.name === "m1_v2_request_envelope");
      const lastAttempt = envelopes.at(-1)?.dimensions.attemptDigest;
      const kinds = new Set(events.filter((event) =>
        event.name === "m1_v2_request_segment" && event.dimensions.attemptDigest === lastAttempt)
        .map((event) => event.dimensions.kind));
      for (const kind of ["older_tool_result_projection", "latest_tool_result_delivery",
        "memory_recall_context", "source_reference", "exact_result_view", "work_recovery_receipt"]) {
        expect(kinds.has(kind)).toBe(true);
      }
      expect(JSON.stringify(requestBodies.at(-1))).not.toContain("assistant-1");
      expect(JSON.stringify(requestBodies.at(-1))).not.toContain("assistant-2");
      expect(requestBodies).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousFlag === undefined) delete process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
      else process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = previousFlag;
    }
  });
});
