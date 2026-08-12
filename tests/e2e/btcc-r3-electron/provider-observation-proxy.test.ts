import { expect, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type AddressInfo } from "node:net";
import { failureEvidence } from "./evidence.ts";
import {
  startProviderObservationProxy,
  type ProviderRequestObservation,
} from "./provider-observation-proxy.ts";

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => await closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for provider proxy observation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("provider observation proxy forwards bytes and streams the first SSE delta before completion", async () => {
  const authorization = "Bearer secret-auth-token";
  const requestBody = Buffer.from(JSON.stringify({
    model: "gpt-test",
    input: "한글 request body",
    prompt_cache_key: "benchmark:btcc-agent-loop",
  }));
  let capturedBody: Buffer = Buffer.alloc(0);
  let capturedAuthorization = "";
  let capturedAcceptEncoding = "";
  let capturedAttemptDigest = "";
  const attemptDigest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  let upstreamCompleted = false;
  let releaseUpstream: (() => void) | undefined;
  const upstreamGate = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const upstream = await listen((request, response) => {
    void (async () => {
      capturedBody = await bodyOf(request);
      capturedAuthorization = String(request.headers.authorization ?? "");
      capturedAcceptEncoding = String(request.headers["accept-encoding"] ?? "");
      capturedAttemptDigest = String(request.headers["x-butler-m1-physical-attempt"] ?? "");
      response.writeHead(202, {
        "content-type": "application/octet-stream",
        "x-upstream-header": "preserved",
      });
      response.write(
        'data: {"type":"response.reasoning_summary_text.delta","delta":"r"}\n\n',
      );
      await upstreamGate;
      response.write([
        'data: {"type":"response.output_text.delta","delta":"hello"}',
        "",
        'data: {"type":"response.function_call_arguments.delta","delta":"{}"}',
        "",
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
      upstreamCompleted = true;
      response.end();
    })();
  });
  const clockValues = [100, 200, 300];
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
    now: () => clockValues.shift() ?? 999,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "accept-encoding": "gzip, br",
        authorization,
        "content-type": "application/json",
        "x-forwarded-fixture": "yes",
        "x-butler-m1-physical-attempt": attemptDigest,
      },
      body: requestBody,
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("x-upstream-header")).toBe("preserved");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain(
      "response.reasoning_summary_text.delta",
    );
    expect(upstreamCompleted).toBe(false);

    releaseUpstream?.();
    while (!(await reader!.read()).done) {
      // Reading to completion proves later bytes continue through the same stream.
    }
    await waitFor(() => proxy.observations()[0]?.completedAtMs !== null);

    expect(capturedBody.equals(requestBody)).toBe(true);
    expect(capturedAuthorization).toBe(authorization);
    expect(capturedAcceptEncoding).toBe("identity");
    expect(capturedAttemptDigest).toBe("");
    expect(proxy.observations()).toEqual([{
      ordinal: 1,
      attemptDigest,
      requestKind: "agent",
      requestedModel: "gpt-test",
      requestedReasoning: null,
      requestedServiceTier: null,
      enforcedAuthMode: null,
      authorizationScheme: "bearer",
      requestStartedAtMs: 100,
      serializedRequestBytes: requestBody.byteLength,
      firstContentBearingDeltaAtMs: 200,
      completedAtMs: 300,
      terminatedAtMs: 300,
      termination: "completed",
      status: 202,
      hasTextContent: true,
      hasToolArgumentContent: true,
      hasReasoningContent: true,
      streamedTextChars: 5,
      finalTextChars: 0,
      providerReportedModel: null,
      providerReportedServiceTier: null,
    }]);
  } finally {
    releaseUpstream?.();
    await proxy.close();
    await upstream.close();
  }
});

test("paired proxy forces ordinary tier in the actual request and rejects conflicting tier", async () => {
  let body: Record<string, unknown> = {};
  const upstream = await listen((request, response) => { void (async () => {
    body = JSON.parse((await bodyOf(request)).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed","response":{"status":"completed","service_tier":"default"}}\n\ndata: [DONE]\n\n');
  })(); });
  const proxy = await startProviderObservationProxy({ upstreamBaseUrl: upstream.baseUrl,
    execution: { model: "openai/gpt-5.6-sol", reasoning: "medium", serviceTier: "default", authMode: "oauth" } });
  try {
    const valid = await fetch(proxy.endpoint, { method: "POST", headers: { authorization: "Bearer redacted", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", reasoning: { effort: "medium" } }) });
    await valid.text();
    expect(body.service_tier).toBe("default");
    expect(proxy.observations()[0]).toMatchObject({ requestedServiceTier: "default", requestedReasoning: "medium", enforcedAuthMode: "oauth", authorizationScheme: "bearer" });
    const conflict = await fetch(proxy.endpoint, { method: "POST", headers: { authorization: "Bearer redacted", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", reasoning: { effort: "medium" }, service_tier: "priority" }) });
    expect(conflict.status).toBeGreaterThanOrEqual(500);
  } finally { await proxy.close(); await upstream.close(); }
});

test("deterministic provider fixture fails the primary once and reports the backup model", async () => {
  const proxy = await startProviderObservationProxy({
    fixture: {
      retryAttempts: 1,
      responses: [
        {
          requestKind: "agent",
          requestModel: "primary-model",
          status: 503,
          errorCode: "fixture_primary_overload",
        },
        {
          requestKind: "agent",
          requestModel: "backup-model",
          responseModel: "backup-model",
          text: "deterministic backup success",
        },
      ],
      defaultResponse: {
        requestKind: "title",
        responseModel: "title-model",
        text: "fixture title",
      },
    },
  });
  try {
    const primary = await fetch(proxy.endpoint, {
      method: "POST",
      body: JSON.stringify({
        model: "primary-model",
        input: "primary",
        tools: [],
      }),
    });
    expect(primary.status).toBe(503);
    await primary.text();
    const backup = await fetch(proxy.endpoint, {
      method: "POST",
      body: JSON.stringify({
        model: "backup-model",
        input: "backup",
        tools: [],
      }),
    });
    expect(backup.status).toBe(200);
    expect(await backup.text()).toContain("deterministic backup success");
    expect(proxy.observations().map((observation) => ({
      kind: observation.requestKind,
      model: observation.requestedModel,
      reported: observation.providerReportedModel,
      termination: observation.termination,
    }))).toEqual([
      {
        kind: "agent",
        model: "primary-model",
        reported: null,
        termination: "failed",
      },
      {
        kind: "agent",
        model: "backup-model",
        reported: "backup-model",
        termination: "completed",
      },
    ]);
  } finally {
    await proxy.close();
  }
});

test("deterministic provider fixture can hold a response open for progress observation", async () => {
  const proxy = await startProviderObservationProxy({
    fixture: {
      responses: [{
        requestKind: "agent",
        requestModel: "backup-model",
        responseModel: "backup-model",
        delayMs: 20,
        text: "delayed backup",
      }],
    },
  });
  try {
    const startedAt = Date.now();
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      body: JSON.stringify({ model: "backup-model", input: "backup", tools: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("delayed backup");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10);
  } finally {
    await proxy.close();
  }
});

test("provider observation proxy separates provider-hosted tool calls from agent rounds", async () => {
  const upstream = await listen(async (request, response) => {
    await bodyOf(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"type":"response.output_text.delta","delta":"검색"}',
      "",
      'data: {"type":"response.output_text.done","text":"검색 결과"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: "private query",
        tools: [{ type: "web_search" }],
      }),
    });
    await response.text();
    await waitFor(() => proxy.observations()[0]?.completedAtMs !== null);
    expect(proxy.observations()[0]).toMatchObject({
      requestKind: "tool_provider",
      streamedTextChars: 2,
      finalTextChars: 5,
      hasTextContent: true,
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("provider observation proxy classifies title calls without retaining sensitive request or response data", async () => {
  const upstreamPathSecret = "custom-upstream-secret";
  const authorizationSecret = "secret-title-authorization";
  const promptSecret = "secret user prompt";
  const deltaSecret = "secret provider delta";
  const cacheKeySecret =
    "private-prefix:native-butler-title-provider";
  let capturedPath = "";
  const upstream = await listen((request, response) => {
    void (async () => {
      capturedPath = request.url ?? "";
      await bodyOf(request);
      response.writeHead(200, {
        "content-type": "text/event-stream",
      });
      response.end([
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: deltaSecret,
        })}`,
        "",
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "message",
            content: [{ type: "output_text", text: deltaSecret }],
          },
        })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    })();
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: `${upstream.baseUrl}/${upstreamPathSecret}`,
  });
  const body = JSON.stringify({
    input: promptSecret,
    prompt_cache_key: cacheKeySecret,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authorizationSecret}`,
        "content-type": "application/json",
      },
      body,
    });
    await response.text();
    await waitFor(() => proxy.observations()[0]?.completedAtMs !== null);

    expect(capturedPath).toBe(
      `/${upstreamPathSecret}/codex/responses`,
    );
    const observations = proxy.observations();
    expect(observations[0]).toMatchObject({
      ordinal: 1,
      requestKind: "title",
      serializedRequestBytes: Buffer.byteLength(body),
      status: 200,
      hasTextContent: true,
      hasToolArgumentContent: false,
      hasReasoningContent: false,
    });
    const serialized = JSON.stringify(observations);
    for (const secret of [
      authorizationSecret,
      promptSecret,
      deltaSecret,
      cacheKeySecret,
      upstreamPathSecret,
      upstream.baseUrl,
      proxy.endpoint,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("non-streaming provider failures keep safe failed terminal evidence", async () => {
  const upstream = await listen((_request, response) => {
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "1",
    });
    response.end(JSON.stringify({
      error: {
        message: "private upstream failure detail",
      },
    }));
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: `${upstream.baseUrl}/codex`,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    await response.text();
    await waitFor(() => proxy.observations()[0]?.termination !== null);
    const providerRequests = proxy.observations();
    expect(providerRequests[0]).toMatchObject({
      requestKind: "auxiliary",
      firstContentBearingDeltaAtMs: null,
      completedAtMs: null,
      termination: "failed",
      status: 429,
      hasTextContent: false,
      hasToolArgumentContent: false,
      hasReasoningContent: false,
    });

    const failure = failureEvidence({
      error: new Error("scenario failed"),
      observations: [],
      options: {},
      providerRequests,
      run: {
        dataRoot: "/isolated/data",
        debugPort: 41001,
        electronProfile: "/isolated/electron",
        evidencePath: "/isolated/evidence.json",
        runId: "run-id",
        runRoot: "/isolated",
        serverPort: 41002,
        workspaceRoot: "/isolated/workspace",
      } as Parameters<typeof failureEvidence>[0]["run"],
    });
    expect(failure.providerRequests).toEqual(providerRequests);
    expect(JSON.stringify(failure)).not.toContain(
      "private upstream failure detail",
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("completed SSE content sets safe shape flags without inventing a first-delta time", async () => {
  const upstream = await listen(async (request, response) => {
    await bodyOf(request);
    response.writeHead(200, {
      "content-type": "text/event-stream",
    });
    response.end([
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"private"}}',
      "",
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"lookup","arguments":"{}"}}',
      "",
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      body: "{}",
    });
    await response.text();
    await waitFor(() => proxy.observations()[0]?.completedAtMs !== null);
    expect(proxy.observations()[0]).toMatchObject({
      firstContentBearingDeltaAtMs: null,
      termination: "completed",
      hasTextContent: true,
      hasToolArgumentContent: true,
      hasReasoningContent: true,
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("failed SSE terminal events are distinguished without retaining provider text", async () => {
  const privateFailure = "private provider failure detail";
  const upstream = await listen(async (request, response) => {
    await bodyOf(request);
    response.writeHead(200, {
      "content-type": "text/event-stream",
    });
    response.end([
      `data: ${JSON.stringify({
        type: "response.failed",
        response: { error: { message: privateFailure } },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      body: "{}",
    });
    await response.text();
    await waitFor(() => proxy.observations()[0]?.termination !== null);
    expect(proxy.observations()[0]).toMatchObject({
      completedAtMs: null,
      status: 200,
      termination: "failed",
    });
    expect(JSON.stringify(proxy.observations())).not.toContain(privateFailure);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("upstream SSE abort terminates the downstream response and records failed evidence", async () => {
  let abortUpstream: (() => void) | undefined;
  const abortGate = new Promise<void>((resolve) => {
    abortUpstream = resolve;
  });
  const upstream = await listen((request, response) => {
    void (async () => {
      await bodyOf(request);
      response.writeHead(200, {
        "content-type": "text/event-stream",
      });
      response.write(
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      );
      await abortGate;
      response.destroy(new Error("fixture upstream aborted"));
    })();
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      body: "{}",
    });
    abortUpstream?.();
    const outcome = await Promise.race([
      response.text().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 500),
      ),
    ]);
    expect(outcome).toBe("rejected");
    await waitFor(() => proxy.observations()[0]?.termination !== null);
    expect(proxy.observations()[0]).toMatchObject({
      status: 200,
      completedAtMs: null,
      termination: "failed",
      hasTextContent: true,
    });
    expect(proxy.observations()[0]?.terminatedAtMs).not.toBeNull();
  } finally {
    abortUpstream?.();
    await proxy.close();
    await upstream.close();
  }
});

test("upstream connection failure returns a generic 502 and records failed evidence", async () => {
  const unavailableUpstream = await listen((_request, response) => {
    response.end();
  });
  const unavailableBaseUrl = unavailableUpstream.baseUrl;
  await unavailableUpstream.close();
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: unavailableBaseUrl,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Provider observation proxy could not reach the upstream provider.",
    );
    await waitFor(() => proxy.observations()[0]?.termination !== null);
    expect(proxy.observations()[0]).toMatchObject({
      completedAtMs: null,
      status: null,
      termination: "failed",
    });
  } finally {
    await proxy.close();
  }
});

test("closing the proxy cancels active provider work without waiting for the upstream timeout", async () => {
  let upstreamAccepted: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    upstreamAccepted = resolve;
  });
  const upstream = await listen((request, _response) => {
    void (async () => {
      await bodyOf(request);
      upstreamAccepted?.();
    })();
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });
  const pendingFetch = fetch(proxy.endpoint, {
    method: "POST",
    body: "{}",
  }).catch(() => null);

  try {
    await accepted;
    const firstClose = proxy.close();
    const concurrentClose = proxy.close();
    const closeOutcome = await Promise.race([
      Promise.all([firstClose, concurrentClose]).then(
        (snapshots) => ({ state: "closed" as const, snapshots }),
      ),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 500),
      ),
    ]);
    expect(closeOutcome).not.toBe("timeout");
    if (closeOutcome === "timeout") throw new Error("Proxy close timed out.");
    expect(closeOutcome.state).toBe("closed");
    expect(closeOutcome.snapshots[0]?.[0]?.termination).toBe("cancelled");
    expect(closeOutcome.snapshots[1]?.[0]?.termination).toBe("cancelled");
    expect(proxy.observations()[0]?.completedAtMs).toBeNull();
    expect(proxy.observations()[0]?.termination).toBe("cancelled");
    expect(proxy.observations()[0]?.terminatedAtMs).not.toBeNull();
    await pendingFetch;
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("closing the proxy cancels an active upstream response stream", async () => {
  const upstream = await listen(async (request, response) => {
    await bodyOf(request);
    response.writeHead(200, {
      "content-type": "text/event-stream",
    });
    response.write(
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    );
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });

  try {
    const response = await fetch(proxy.endpoint, {
      method: "POST",
      body: "{}",
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader!.read()).done).toBe(false);
    const closeOutcome = await Promise.race([
      proxy.close().then((snapshot) => ({
        state: "closed" as const,
        snapshot,
      })),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 500),
      ),
    ]);
    expect(closeOutcome).not.toBe("timeout");
    if (closeOutcome === "timeout") throw new Error("Proxy close timed out.");
    expect(closeOutcome.snapshot[0]).toMatchObject({
      completedAtMs: null,
      status: 200,
      termination: "cancelled",
    });
    const downstreamOutcome = await Promise.race([
      reader!.read().then(
        (result) => result.done ? "closed" as const : "data" as const,
        () => "closed" as const,
      ),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 500),
      ),
    ]);
    expect(downstreamOutcome).toBe("closed");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("closing the proxy cancels a partially uploaded inbound request", async () => {
  const upstream = await listen((_request, response) => {
    response.end();
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });
  const request = httpRequest(proxy.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const requestClosed = new Promise<void>((resolve) => {
    request.once("close", resolve);
    request.once("error", () => resolve());
  });
  request.flushHeaders();
  request.write("{");

  try {
    await waitFor(() => proxy.observations().length === 1);
    const closeOutcome = await Promise.race([
      proxy.close().then((snapshot) => ({
        state: "closed" as const,
        snapshot,
      })),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 500),
      ),
    ]);
    expect(closeOutcome).not.toBe("timeout");
    if (closeOutcome === "timeout") throw new Error("Proxy close timed out.");
    expect(closeOutcome.snapshot[0]).toMatchObject({
      completedAtMs: null,
      termination: "cancelled",
    });
    await requestClosed;
  } finally {
    request.destroy();
    await proxy.close();
    await upstream.close();
  }
});

test("provider observation snapshots cannot mutate retained evidence", async () => {
  const upstream = await listen(async (request, response) => {
    await bodyOf(request);
    response.writeHead(204);
    response.end();
  });
  const proxy = await startProviderObservationProxy({
    upstreamBaseUrl: upstream.baseUrl,
  });

  try {
    await fetch(proxy.endpoint, {
      method: "POST",
      body: "{}",
    });
    await waitFor(() => proxy.observations()[0]?.completedAtMs !== null);
    const first = proxy.observations();
    (first[0] as ProviderRequestObservation).status = 999;
    expect(proxy.observations()[0]?.status).toBe(204);
  } finally {
    await proxy.close();
    await proxy.close();
    await upstream.close();
  }
});
