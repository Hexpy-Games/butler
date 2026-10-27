// test-category: pure-logic
import { expect, test } from "bun:test";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";
import { collectRoutes, sources } from "../support/app-bridge-route-analysis";
import { checkPreload, exercise, placeholders, preloadProbe, recordingBridge, withBridge,
  type Invocation, type RecordedRoute } from "../support/app-bridge-route-replay";

test("UI API routes are accepted by methods exposed by the actual Electron preload", async () => {
  const started = performance.now();
  const { routes, unresolved } = collectRoutes();
  const collectRoutesMs = performance.now() - started;
  const allowedUnresolved = [
    // Server-supplied file path; api's message-file route and preload's file-ID validation bound it.
    { site: "src/components/artifacts/HtmlFileFrame.tsx:20", reason: "Server-supplied message-file path, validated by renderer route and preload file-ID guard." },
  ];
  expect(unresolved.filter(route => !allowedUnresolved.some(entry => entry.site === route.site))).toEqual([]);
  expect(routes.length).toBeGreaterThan(140);
  expect(sources.length).toBeGreaterThan(300);
  expect(routes.some(route => route.paths.includes("/usage-history"))).toBe(true);
  const recorded: Invocation[] = [];
  const accepted: RecordedRoute[] = [];
  const gaps: string[] = [];
  const validationErrors: string[] = [];
  const exerciseStart = performance.now();
  await withBridge(recordingBridge(recorded), async () => {
    for (const route of routes) for (const path of route.paths) {
      const result = await exercise(route, path, recorded);
      if (result.gap) gaps.push(`${route.site} ${route.method} ${path}: ${result.errors.join("; ")}`);
      else {
        validationErrors.push(...result.errors.map(error => `${route.site}: ${error}`));
        if (result.accepted) accepted.push(result.accepted);
      }
    }
  });
  const rendererExerciseMs = performance.now() - exerciseStart;
  const preload = await checkPreload(accepted);
  console.info({ collectRoutesMs, rendererExerciseMs, firstPreloadMs: preload.firstPreloadMs,
    retryMs: preload.retryMs, nodeChildren: preload.nodeChildren, testMs: performance.now() - started });
  console.info(JSON.stringify({ preloadInvocationsChecked: preload.checked, callSites: new Set(routes.map(route => route.site)).size, routeVariants: routes.reduce((count, route) => count + route.paths.length, 0), bridgeMethods: new Set(recorded.map(call => call.method)).size, gatewayMatchedForwards: preload.gateway.matched, unresolved, allowedUnresolved, validationErrors }, null, 2));
  const keys = preload.keys;
  expect(preload.gateway.unmatched, "Preload forwards missing from gateway route tables (method, path, site)").toEqual([]);
  expect(preload.refusals).toEqual([]);
  expect([...new Set(recorded.map(call => call.method))].filter(method => !keys.includes(method))).toEqual([]);
  expect(gaps).toEqual([]);
  expect(validationErrors).toEqual([]);
});

test("usage history crosses renderer and real preload with its entire query unchanged", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const inputs: unknown[] = [];
  const paths = ["/usage-history?x=1", "/usage-history", "/usage-history?unknown=a%2Bb&x=1&x=2&blank="];
  await withBridge({ getUsageHistory: async (input: unknown) => {
    inputs.push(input);
    calls.push(...preloadProbe([{ method: "getUsageHistory", input }]).calls);
    return {};
  } }, async () => {
    for (const path of paths) await api(path);
  });
  expect(inputs).toEqual(paths.map(path => ({ query: new URL(path, "http://local").search })));
  expect(calls).toEqual(paths.map(path => ({ path, method: "GET" })));
});


test("document, saved-item and preview routes reach the agent through the real preload", async () => {
  const routes = [
    ["GET", "/documents/d"], ["GET", "/documents/d/revisions"], ["GET", "/documents/d/revisions/2?x=a%2Bb"], ["GET", "/documents/d/diff?from=1&x=1&x=2&blank="],
    ["POST", "/documents"], ["PUT", "/documents/d"], ["POST", "/documents/d/restore"],
    ["POST", "/documents/d/seen?x=1"], ["POST", "/documents/d/blocks/0"], ["POST", "/library/documents"], ["POST", "/library/blocks"],
    ["GET", `/previews/p-${"a".repeat(64)}/view?revision=1`],
  ];
  const recorded: Invocation[] = [];
  await withBridge(recordingBridge(recorded), async () => {
    for (const [method, path] of routes) await api(path, { method, ...(method === "GET" ? {} : { body: "{}" }) });
  });
  const output = preloadProbe(recorded);
  expect(output.errors).toEqual(recorded.map(() => null));
  expect(output.calls).toEqual(routes.map(([method, path]) => ({
    path, method, ...(method === "GET" ? {} : { body: {} }),
  })));
});

test.each([["PUT", "/documents/d"], ["POST", "/documents/d/restore"]])(
  "%s %s preserves revision conflicts through the serialized preload result",
  async (method, path) => {
    const body = { expected_rev: 1 };
    const response = { status: 409, body: { code: "revision_conflict", rev: 2, error: {
      code: "revision_conflict", message: "Read the current revision and retry.", rev: 2,
    } } };
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    await withBridge({ documents: async (input: unknown) => {
      const output = preloadProbe([{ method: "documents", input }], [], response);
      calls.push(...output.calls);
      expect(output.values[0]).toMatchObject({ ok: false, error: { code: "revision_conflict", status: 409 } });
      return output.values[0];
    } }, async () => {
      const error = await api(path, { method, body: JSON.stringify(body) }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      // DocumentSession reads error.code, then reloads the current document revision.
      expect(error).toMatchObject({ code: "revision_conflict", status: 409 });
    });
    expect(calls).toEqual([{ path, method, body }]);
  },
);

test.each([["saveLibraryDocument", "/library/documents"], ["saveLibraryBlock", "/library/blocks"]])(
  "%s preserves error codes through the serialized preload result",
  async (bridgeMethod, path) => {
    await withBridge({ [bridgeMethod]: async (input: unknown) => preloadProbe([{ method: bridgeMethod, input }], [], {
      status: 400, body: { error: { code: "invalid_request", message: "Invalid request." } },
    }).values[0] }, async () => {
      const error = await api(path, { method: "POST", body: "{}" }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "invalid_request", status: 400 });
    });
  },
);

test("document and library success envelopes unwrap after preload serialization", async () => {
  await withBridge(new Proxy({}, { get: (_target, method) => async (input: unknown) =>
    preloadProbe([{ method: String(method), input }]).values[0] }), async () => {
    expect(await api<Record<string, unknown>>("/documents/d")).toEqual({});
    for (const path of ["/library/documents", "/library/blocks"]) {
      expect(await api<Record<string, unknown>>(path, { method: "POST", body: "{}" })).toEqual({});
    }
  });
});


test("new preload methods reject unrelated paths and unsupported document methods", () => {
  const refused = [
    { method: "getUsageHistory", input: { query: "/../settings?x=1" } },
    { method: "documents", input: { path: "/settings", method: "GET" } },
    { method: "documents", input: { path: "/documents/d", method: "DELETE" } },
    { method: "documents", input: { path: "/documents/d/../..//settings", method: "POST" } },
    { method: "getPreviewView", input: { previewId: `p-${"a".repeat(64)}`, query: "/../../settings" } },
    { method: "getPreviewView", input: { previewId: "../settings" } },
  ];
  const output = preloadProbe([], refused);
  expect(output.refusals).toEqual(refused.map(() => true));
  expect(output.calls).toEqual([]);
});

test("document preload normalizes methods while preserving query strings", () => {
  const routes = [["get", "/documents/d/diff?from=2&x=a%2Bb"], ["post", "/documents/d/seen?x=1"], ["put", "/documents/d?x=1"]];
  const output = preloadProbe(routes.map(([method, path]) => ({ method: "documents", input: { path, method } })));
  expect(output.errors).toEqual(routes.map(() => null));
  expect(output.calls).toEqual(routes.map(([method, path]) => ({ path, method: method.toUpperCase() })));
});

test("memory consolidation reaches the gateway for reads and starts", async () => {
  const recorded: Invocation[] = [];
  await withBridge(recordingBridge(recorded), async () => {
    await api("/memory/consolidation");
    await api("/memory/consolidation", { method: "POST", body: JSON.stringify({ operation_id: placeholders[1] }) });
  });
  const output = preloadProbe(recorded, [{ method: "memoryRequest", input: { path: "/memory/consolidation", method: "DELETE" } }]);
  expect(output.errors).toEqual([null, null]);
  expect(output.refusals).toEqual([true]);
  expect(output.calls).toEqual([
    { path: "/memory/consolidation", method: "GET" },
    { path: "/memory/consolidation", method: "POST", body: { operation_id: placeholders[1] } },
  ]);
});


test("memory consolidation preserves the gateway busy status through the real preload", async () => {
  await withBridge({ memoryRequest: async (input: unknown) => preloadProbe([{ method: "memoryRequest", input }], [], {
    status: 409, body: { protocol_version: "butler.app.v1", error: { code: "memory_operation_unavailable", message: "Memory operation unavailable." } },
  }).values[0] }, async () => {
    const error = await api("/memory/consolidation", { method: "POST", body: "{}" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status: 409, code: "memory_operation_unavailable" });
  });
});

test("malformed preview encoding produces an ordinary renderer error", async () => {
  const recorded: Invocation[] = [];
  await withBridge(recordingBridge(recorded), async () => {
    const error = await api("/previews/%/view").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(URIError);
    expect((error as Error).message).toBe("Invalid preview");
  });
  expect(recorded).toEqual([]);
});

test("preview preload accepts only the generated p-prefixed SHA-256 identity", () => {
  const ids = [`p-${"0".repeat(64)}`, `p-${"abcdef0123456789".repeat(4)}`];
  const invalid = ["p", "", "a".repeat(64), `p-${"A".repeat(64)}`, `p-${"a".repeat(63)}`, `p-${"a".repeat(65)}`, `p-${"g".repeat(64)}`, "../settings", "p-%", null];
  const output = preloadProbe(ids.map(previewId => ({ method: "getPreviewView", input: { previewId } })),
    invalid.map(previewId => ({ method: "getPreviewView", input: { previewId } })));
  expect(output.errors).toEqual(ids.map(() => null));
  expect(output.refusals).toEqual(invalid.map(() => true));
  expect(output.calls).toEqual(ids.map(id => ({ path: `/previews/${id}/view`, method: "GET" })));
});
