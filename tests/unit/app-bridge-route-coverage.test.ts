// test-category: security
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";
import ts from "typescript";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

const root = resolve(import.meta.dir, "../../packages/butler-app/client/ui");
const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const sources = program.getSourceFiles().filter(source => source.fileName.startsWith(`${root}/src/`)
  && /\.tsx?$/.test(source.fileName)
  && !/\.(test\.[^/]+|showcase\.tsx|guidance\.tsx)$/.test(source.fileName)
  && source.fileName !== resolve(root, "src/app/api.ts"));
const calls: ts.CallExpression[] = [];
const callsByName = new Map<string, ts.CallExpression[]>();
function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
}
function visit(node: ts.Node) {
  if (ts.isCallExpression(node)) {
    calls.push(node);
    const name = calleeName(node.expression);
    if (name) {
      const named = callsByName.get(name) ?? [];
      named.push(node);
      callsByName.set(name, named);
    }
  }
  ts.forEachChild(node, visit);
}
for (const source of sources) visit(source);

const signatures = new Map<ts.CallExpression, ts.Signature | undefined>();
function signature(call: ts.CallExpression) {
  if (!signatures.has(call)) signatures.set(call, checker.getResolvedSignature(call));
  return signatures.get(call);
}
const callersByOwner = new Map<ts.Node, ts.CallExpression[]>();
function callers(owner: ts.Node): ts.CallExpression[] {
  const cached = callersByOwner.get(owner);
  if (cached) return cached;
  let name: string | undefined;
  if (ts.isFunctionDeclaration(owner)) name = owner.name?.text;
  if (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
    if (ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) name = owner.parent.name.text;
    else if (ts.isFunctionExpression(owner)) name = owner.name?.text;
  }
  const matches = (name ? callsByName.get(name) ?? [] : [])
    .filter(call => signature(call)?.declaration === owner);
  callersByOwner.set(owner, matches);
  return matches;
}

type Bindings = Map<ts.Symbol, string[]>;
const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
function declaration(node: ts.Node): ts.Declaration | undefined {
  const found = symbol(node);
  return (found && (found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found))?.declarations?.[0];
}
function combinations(head: string[], tail: string[]): string[] {
  return head.flatMap(prefix => tail.map(suffix => prefix + suffix));
}

// Evaluate only string structure: no UI code is executed. Unknown values become x.
// Literal unions and conditionals preserve route verbs; helper calls preserve prefixes.
function strings(node: ts.Node | undefined, env: Bindings = new Map(), depth = 0): string[] {
  if (!node || depth > 16) return ["x"];
  const next = (value: ts.Node | undefined, bindings = env) => strings(value, bindings, depth + 1);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return next(node.expression);
  if (ts.isConditionalExpression(node)) return [...next(node.whenTrue), ...next(node.whenFalse)];
  if (ts.isTemplateExpression(node)) {
    let result = [node.head.text];
    for (const span of node.templateSpans) result = combinations(result, next(span.expression).map(value => value + span.literal.text));
    return [...new Set(result)];
  }
  const type = checker.getTypeAtLocation(node);
  const present = checker.getNonNullableType(type);
  const members = present.isUnion() ? present.types : [present];
  if (members.every(member => member.flags & ts.TypeFlags.NumberLike)) {
    return members.map(member => member.isNumberLiteral() ? String(member.value) : "1");
  }
  const bound = symbol(node);
  if (bound && env.has(bound)) return env.get(bound)!;
  const decl = declaration(node);
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return next(decl.initializer);
  if (decl && ts.isParameter(decl)) {
    const owner = decl.parent;
    const index = (owner as ts.SignatureDeclaration).parameters.indexOf(decl);
    const values = callers(owner).flatMap(call => next(call.arguments[index]));
    if (values.length) return [...new Set(values)];
  }
  if (ts.isCallExpression(node)) {
    const target = signature(node)?.declaration;
    if (target && (ts.isArrowFunction(target) || ts.isFunctionDeclaration(target)) && target.body
      && sources.includes(target.getSourceFile())) {
      const bindings = new Map(env);
      target.parameters.forEach((parameter, index) => {
        const key = symbol(parameter.name);
        if (key) bindings.set(key, next(node.arguments[index]));
      });
      if (!ts.isBlock(target.body)) return next(target.body, bindings);
      const returns = target.body.statements.filter(ts.isReturnStatement);
      if (returns.length) return returns.flatMap(statement => next(statement.expression, bindings));
    }
  }
  if (members.every(member => member.isStringLiteral())) return members.map(member => (member as ts.StringLiteralType).value);
  return ["x"];
}

interface Route { site: string; method: string; paths: string[] }
function collectRoutes() {
  const routes: Route[] = [];
  const skipped: string[] = [];
  const dynamicPaths: string[] = [];
  for (const call of calls) {
    const name = call.expression.getText();
    const canonWrite = name === "write" && call.getSourceFile().fileName === resolve(root, "src/app/canonApi.ts");
    if (name !== "api" && !canonWrite) continue;
    const source = call.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(call.getStart()).line + 1;
    const site = `${relative(root, source.fileName)}:${line}`;
    const options = call.arguments[1];
    const property = options && ts.isObjectLiteralExpression(options)
      ? options.properties.find(prop => prop.name?.getText().replace(/["']/g, "") === "method") : undefined;
    const methodNode = canonWrite ? options : property && ts.isPropertyAssignment(property) ? property.initializer : property;
    if ((methodNode && !ts.isStringLiteralLike(methodNode)) || (!canonWrite && options && !ts.isObjectLiteralExpression(options))) {
      skipped.push(site);
      continue;
    }
    const method = methodNode && ts.isStringLiteralLike(methodNode) ? methodNode.text.toUpperCase() : "GET";
    const argument = call.arguments[0];
    if (argument && !ts.isStringLiteralLike(argument) && !ts.isTemplateExpression(argument) && !ts.isCallExpression(argument)) {
      dynamicPaths.push(site);
      continue;
    }
    const paths = strings(argument);
    if (paths.every(path => path === "x")) {
      dynamicPaths.push(site);
      continue;
    }
    routes.push({ site, method, paths: [...new Set(paths)] });
  }
  return { routes, skipped, dynamicPaths };
}

interface Invocation { method: string; input: unknown }
const preloadPath = resolve(root, "../electron/preload.cjs");
function preloadProbe(
  invocations: Invocation[] = [],
  refused: Invocation[] = [],
  response?: { status: number; body: unknown },
) {
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const calls = []; const refusals = []; const errors = []; const values = [];
    const response = ${JSON.stringify(response ?? null)};
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async () => null, on() {}, send() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname + parsed.search, method: options.method ?? "GET", ...(options.body === undefined ? {} : { body: JSON.parse(options.body) }) });
      return response ? { ok: response.status < 400, status: response.status, json: async () => response.body }
        : { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      for (const { method, input } of ${JSON.stringify(invocations)}) {
        try {
          const value = await bridge[method](input); values.push(value);
          errors.push(value?.ok === false ? JSON.stringify(value.error) : null);
        }
        catch (error) { values.push(null); errors.push(String(error)); }
      }
      for (const { method, input } of ${JSON.stringify(refused)}) {
        try { await bridge[method](input); refusals.push(false); }
        catch { refusals.push(true); }
      }
      process.stdout.write(JSON.stringify({ keys: Object.keys(bridge), calls, refusals, errors, values }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8", env: { ...process.env, BUTLER_APP_SERVER_URL: "http://127.0.0.1:1" } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { errors: Array<string | null>; values: unknown[]; keys: string[]; refusals: boolean[]; calls: Array<{ path: string; method: string; body?: unknown }> };
}

function recordingBridge(recorded: Invocation[]) {
  return new Proxy({}, { get: (_target, key) => async (input: unknown) => {
    recorded.push({ method: String(key), input });
    return { ok: true, data: {} };
  } });
}
async function withBridge<T>(bridge: object, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: bridge } });
  try { return await run(); }
  finally { Object.assign(globalThis, { window: previous }); }
}

// Representative opaque IDs also exercise route tables that validate UUIDs, hashes or trace IDs.
const placeholders = ["x", "00000000-0000-4000-8000-000000000000", "a".repeat(64), "a".repeat(32),
  "file-00000000-0000-4000-8000-000000000000", "/message-files/file-00000000-0000-4000-8000-000000000000"];
interface RecordedRoute {
  route: Route; path: string; candidate: string; placeholder: string; invocations: Invocation[];
}
async function exercise(route: Route, path: string, recorded: Invocation[], ids = placeholders) {
  const errors: string[] = [];
  for (const placeholder of ids) {
    const candidate = path.replace(/\bx\b/g, placeholder);
    const before = recorded.length;
    try { await api(candidate, { method: route.method, ...(route.method === "GET" ? {} : { body: "{}" }) }); }
    catch (error) { errors.push(String(error)); }
    if (recorded.length > before) return {
      errors: errors.filter(error => !/Unsupported Butler app API route/.test(error)), gap: false,
      accepted: { route, path, candidate, placeholder, invocations: recorded.slice(before) },
    };
  }
  return { errors, gap: true };
}

function refusalReasons(entry: RecordedRoute, errors: Array<string | null>) {
  return errors.flatMap((error, index) => error === null ? []
    : [`${entry.route.site} ${entry.route.method} ${entry.candidate} -> ${entry.invocations[index].method}: ${error}`]);
}

// Replay the exact renderer inputs first, then batch every alternative for rejected routes.
async function checkPreload(accepted: RecordedRoute[]) {
  const invocations = accepted.flatMap(entry => entry.invocations);
  const firstStart = performance.now();
  const output = preloadProbe(invocations);
  const firstPreloadMs = performance.now() - firstStart;
  const retryStart = performance.now();
  let offset = 0;
  const pending = [];
  const alternatives: Invocation[] = [];
  for (const entry of accepted) {
    const errors = output.errors.slice(offset, offset + entry.invocations.length);
    offset += entry.invocations.length;
    if (errors.every(error => error === null)) continue;
    const attempts = refusalReasons(entry, errors);
    const candidates = [];
    for (const placeholder of placeholders.filter(id => id !== entry.placeholder && /\bx\b/u.test(entry.path))) {
      const recorded: Invocation[] = [];
      const result = await withBridge(recordingBridge(recorded), () => exercise(entry.route, entry.path, recorded, [placeholder]));
      if (!result.accepted) continue;
      const start = alternatives.length;
      alternatives.push(...recorded);
      candidates.push({ entry: result.accepted, rendererErrors: result.errors, start, end: alternatives.length });
    }
    pending.push({ attempts, candidates });
  }
  const replay = alternatives.length ? preloadProbe(alternatives) : undefined;
  const refusals: string[] = [];
  for (const { attempts, candidates } of pending) {
    let allowed = false;
    for (const candidate of candidates) {
      const errors = replay!.errors.slice(candidate.start, candidate.end);
      attempts.push(...refusalReasons(candidate.entry, errors));
      if (!candidate.rendererErrors.length && errors.every(error => error === null)) allowed = true;
    }
    if (!allowed) refusals.push(...attempts);
  }
  return {
    keys: output.keys, refusals, checked: invocations.length + alternatives.length,
    firstPreloadMs, retryMs: performance.now() - retryStart, nodeChildren: 1 + Number(!!replay),
  };
}

test("UI API routes are accepted by methods exposed by the actual Electron preload", async () => {
  const started = performance.now();
  const { routes, skipped, dynamicPaths } = collectRoutes();
  const collectRoutesMs = performance.now() - started;
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
  console.info(JSON.stringify({ preloadInvocationsChecked: preload.checked, callSites: routes.length, routeVariants: routes.reduce((count, route) => count + route.paths.length, 0), bridgeMethods: new Set(recorded.map(call => call.method)).size, skipped, dynamicPaths, validationErrors }, null, 2));
  const keys = preload.keys;
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
    ["GET", "/previews/p/view?revision=1"],
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
    const body = { revision: 1 };
    const response = { status: 409, body: { error: {
      code: "revision_conflict", message: "Document has changed.", current: { revision: 2 },
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
      expect(error).toMatchObject({ code: "revision_conflict", status: 409, current: { revision: 2 } });
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
    { method: "getPreviewView", input: { previewId: "p", query: "/../../settings" } },
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
