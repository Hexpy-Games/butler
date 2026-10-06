// Isolated native (Rust) App gateway for browser/Electron smokes.
//
// Replaces the retired in-process TypeScript `createAppServer` test composition.
// The executable is resolved from BUTLER_NATIVE_AGENT_EXECUTABLE (absolute) or the
// local release build. Each handle owns a temporary installation copy, BUTLER_DATA,
// HOME and CODEX_HOME, a private loopback port, and a stub OpenAI-compatible
// "Custom" model endpoint, so no real provider or live Butler state is touched.
//
// Local auth is always on in the gateway: it creates its bearer token at
// `$BUTLER_DATA/app/runtime/auth/local-agent-auth.json`. `api()` sends it, and
// `signIn()` gives a browser context the session cookie a one-time connection
// code sets (the path `butler open` uses), so pages load the UI as a user would.
// A UI served from another origin (a proxy, Vite) must be listed in
// `devOrigins` (BUTLER_APP_DEV_ORIGIN), or the gateway answers 403
// origin_not_allowed.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

export type StubModelRequest = { stream: boolean; messages: unknown[]; body: Record<string, unknown> };

export type NativeAppServerOptions = {
  butlerData?: string;
  uiRoot?: string;
  config?: Record<string, unknown>;
  /** Marks first-chat onboarding complete before launch. Default true. */
  onboardingComplete?: boolean;
  stubReply?: (request: StubModelRequest) => string | Promise<string>;
  /** Deterministic tool response for browser tests of durable forms. */
  stubToolCall?: (request: StubModelRequest) => { name: string; arguments: Record<string, unknown> } | null;
  readyTimeoutMs?: number;
  /** Exact renderer origins (`http://127.0.0.1:<port>`, no trailing slash) serving the UI from elsewhere. */
  devOrigins?: string[];
  /** Extra agent environment (e.g. local sign-in and local-server probe addresses). */
  env?: Record<string, string>;
};

/** A Playwright BrowserContext (or anything with its `addCookies`). */
export type CookieJar = {
  addCookies(cookies: Array<{ name: string; value: string; url: string; httpOnly?: boolean; sameSite?: "Strict" | "Lax" | "None" }>): Promise<void>;
};

export type NativeAppServerHandle = {
  url: string;
  port: number;
  /** Owned gateway PID for native resource measurements. */
  pid: number;
  butlerData: string;
  stubModelCalls: StubModelRequest[];
  /** The gateway's local bearer token (read from the temp BUTLER_DATA). */
  token: string;
  /** `{ authorization: "Bearer <token>" }` for raw fetches. */
  authHeaders: Record<string, string>;
  api<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  /** A fresh one-time `/connect?code=..` link (valid 5 minutes). */
  connectUrl(): Promise<string>;
  /** Gives a browser context (or a page's context) a gateway browser session. */
  signIn(target: CookieJar | { context(): CookieJar }): Promise<void>;
  /** Diagnose an unexpected shutdown without exposing the local auth token. */
  assertRunning(): void;
  stop(): Promise<void>;
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// ---------------------------------------------------------------------------
// Process tracking: a spawned gateway must never outlive its owner.
//
// Each tracked child is spawned detached, so it leads its own process group and
// anything it forks is signalled with it; signals target only that exact PID's
// group (never a name pattern). Cleanup runs on `stop()`, on normal exit, on
// SIGINT/SIGTERM, after an uncaught exception, and in bun:test teardown.
// ---------------------------------------------------------------------------

export type TrackedProcess = {
  child: ChildProcess;
  pid: number;
  /** SIGTERM the group, SIGKILL after the grace period, wait for exit, remove cleanup paths. */
  stop(graceMs?: number): Promise<void>;
};

type TrackedEntry = { child: ChildProcess; pid: number; cleanupPaths: string[]; stopping?: Promise<void> };

const tracked = new Map<number, TrackedEntry>();
let exitHooksInstalled = false;

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalGroup(entry: TrackedEntry, signal: NodeJS.Signals): void {
  try {
    process.kill(-entry.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH" && hasExited(entry.child)) throw error;
  }
  // Also signal the exact ChildProcess we own: restricted macOS runners can
  // refuse group delivery. StopSignal coalesces duplicate graceful requests.
  if (!hasExited(entry.child)) entry.child.kill(signal);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(hasExited(child)), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); done(true); });
  });
}

function removeCleanupPaths(entry: TrackedEntry): void {
  for (const path of entry.cleanupPaths) rmSync(path, { recursive: true, force: true });
}

async function stopTracked(entry: TrackedEntry, graceMs = 15_000): Promise<void> {
  entry.stopping ??= (async () => {
    if (!hasExited(entry.child)) {
      entry.child.stdin?.end();
      signalGroup(entry, "SIGTERM");
      if (!(await waitForExit(entry.child, graceMs))) {
        signalGroup(entry, "SIGKILL");
        if (!(await waitForExit(entry.child, 5_000))) throw new Error(`Owned gateway ${entry.pid} did not exit`);
      }
    }
    // Anything the leader forked and left behind in its group.
    signalGroup(entry, "SIGKILL");
    removeCleanupPaths(entry);
    tracked.delete(entry.pid);
  })();
  await entry.stopping;
}

/** Synchronous last resort for `exit`: no waiting is possible there. */
function killAllTrackedSync(): void {
  for (const entry of tracked.values()) {
    signalGroup(entry, "SIGKILL");
    removeCleanupPaths(entry);
  }
  tracked.clear();
}

export async function stopAllTrackedProcesses(graceMs?: number): Promise<void> {
  await Promise.all([...tracked.values()].map((entry) => stopTracked(entry, graceMs)));
}

export function liveTrackedProcessIds(): number[] {
  return [...tracked.keys()];
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on("exit", killAllTrackedSync);
  // Node emits this before crashing; Bun skips it but still emits `exit`.
  process.on("uncaughtExceptionMonitor", killAllTrackedSync);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const onSignal = () => {
      void stopAllTrackedProcesses(3_000).finally(() => {
        process.off(signal, onSignal);
        // Keep the default outcome (terminate by this signal) unless the owner handles it.
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    };
    process.on(signal, onSignal);
  }
}

export function spawnTrackedProcess(
  command: string,
  args: string[],
  options: Omit<SpawnOptions, "detached"> & { cleanupPaths?: string[] } = {},
): TrackedProcess {
  installExitHooks();
  const { cleanupPaths = [], ...spawnOptions } = options;
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions, detached: true });
  if (child.pid === undefined) {
    for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
    throw new Error(`Failed to spawn ${command}`);
  }
  const entry: TrackedEntry = { child, pid: child.pid, cleanupPaths };
  tracked.set(entry.pid, entry);
  child.once("exit", () => {
    // A child that exits on its own still leaves its temp dirs until stop/exit.
    if (!entry.stopping) signalGroup(entry, "SIGKILL");
  });
  return { child, pid: entry.pid, stop: (graceMs) => stopTracked(entry, graceMs) };
}

// Test-runner teardown: inside `bun test`, stop whatever a file left running.
try {
  const { afterAll } = await import("bun:test");
  afterAll(() => stopAllTrackedProcesses());
} catch {
  // Not running under the bun test runner (smoke scripts): exit hooks cover it.
}

export function nativeAgentExecutable(): string {
  const configured = process.env.BUTLER_NATIVE_AGENT_EXECUTABLE?.trim();
  const path = configured || join(repositoryRoot, "packages/butler-agent/rust/target/release/butler-agent");
  if (!existsSync(path)) {
    throw new Error(`Native Butler Agent executable not found: ${path}. Build it or set BUTLER_NATIVE_AGENT_EXECUTABLE.`);
  }
  return path;
}

export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** A gateway fixture needs both its API port and adjacent content port. */
async function freeGatewayPort(): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = 20_000 + 2 * Math.floor(Math.random() * 6_000);
    const sockets = [createNetServer(), createNetServer()];
    try {
      for (const [index, socket] of sockets.entries()) {
        await new Promise<void>((done, fail) => {
          socket.once("error", fail);
          socket.listen(port + index, "127.0.0.1", done);
        });
      }
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    } finally {
      await Promise.all(sockets.filter(socket => socket.listening).map(socket => new Promise<void>(done => socket.close(() => done()))));
    }
  }
  throw new Error("No gateway fixture port pair available");
}

export const LOCAL_AUTH_FILE = "app/runtime/auth/local-agent-auth.json";

/** The bearer token the gateway keeps in its data folder, once it exists. */
export function readLocalAuthToken(butlerData: string): string | null {
  try {
    const stored = JSON.parse(readFileSync(join(butlerData, LOCAL_AUTH_FILE), "utf8")) as { token?: unknown };
    return typeof stored.token === "string" && stored.token.length >= 32 ? stored.token : null;
  } catch {
    return null;
  }
}

export function writeOnboardingComplete(butlerData: string): void {
  const now = new Date().toISOString();
  mkdirSync(join(butlerData, "personalization"), { recursive: true, mode: 0o700 });
  writeFileSync(join(butlerData, "personalization/onboarding.json"), `${JSON.stringify({
    schema: "butler.first_chat_onboarding.v1", status: "complete", gateway: "any", fields: {},
    skipped_fields: [], created_at: now, updated_at: now, completed_at: now,
  }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Marks the app's first run as done at the current consent version so smokes
 * open the workspace. Agents before #230 have no `settings.onboarding`; for
 * them the smokes' legacy renderer flag keeps doing that job.
 */
async function completeAppOnboarding(url: string, token: string): Promise<void> {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const settings = await fetch(`${url}settings`, { headers }).then((response) => response.json()).catch(() => null) as
    { data?: { onboarding?: Record<string, unknown> | null } } | null;
  const onboarding = settings?.data?.onboarding;
  if (!onboarding) return;
  const now = new Date().toISOString();
  await fetch(`${url}settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(onboardingCompletedPatch(onboarding, now, now)),
  });
}

async function startStubModel(
  reply: NativeAppServerOptions["stubReply"],
  calls: StubModelRequest[],
  toolReply?: NativeAppServerOptions["stubToolCall"],
): Promise<{ server: Server; port: number }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "stub", object: "model" }] }));
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* empty */ }
    const call = { stream: body.stream === true, messages: Array.isArray(body.messages) ? body.messages : [], body };
    calls.push(call);
    const text = reply ? await reply(call) : "Stub reply from the isolated smoke model.";
    const tool = toolReply?.(call);
    const toolCalls = tool ? [{ id: `call-${calls.length}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] : undefined;
    const finishReason = tool ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!call.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `stub-${calls.length}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "stub",
        choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: text, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }], usage,
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: `stub-${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text, ...(toolCalls ? { tool_calls: toolCalls.map((tool, index) => ({ ...tool, index })) } : {}) } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

export async function createNativeAppServer(options: NativeAppServerOptions = {}): Promise<NativeAppServerHandle> {
  const scratch = mkdtempSync(join(tmpdir(), "butler-native-smoke-"));
  const butlerData = options.butlerData ?? join(scratch, "data");
  const home = join(scratch, "home");
  const installation = join(scratch, "install");
  const resources = join(installation, "resources");
  mkdirSync(butlerData, { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(installation, "bin"), { recursive: true });
  // APFS clone (cp -c semantics) keeps the ~500MB binary copy cheap; the
  // service requires a canonical executable inside its installation root.
  cpSync(nativeAgentExecutable(), join(installation, "bin/butler-agent"), { mode: 2 /* COPYFILE_FICLONE */ });
  cpSync(join(repositoryRoot, "packages/butler-agent/resources"), resources, { recursive: true });
  const uiRoot = options.uiRoot ?? join(repositoryRoot, "packages/butler-app/client/ui/dist");
  if (!existsSync(join(uiRoot, "index.html"))) throw new Error(`UI build missing: ${uiRoot}`);
  cpSync(uiRoot, join(resources, "app-client/dist"), { recursive: true });

  const stubModelCalls: StubModelRequest[] = [];
  const stub = await startStubModel(options.stubReply, stubModelCalls, options.stubToolCall);
  if (options.onboardingComplete !== false) writeOnboardingComplete(butlerData);
  const configPath = join(butlerData, "butler.config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify({
      user: { name: "Smoke", language: "ko" },
      system: { defaultModel: "local/stub" },
      models: { local: [{
        model_id: "stub", display_name: "Stub", server_url: `http://127.0.0.1:${stub.port}`,
        context_window_tokens: 128000,
      }] },
      metrics: { enabled: false },
      ...options.config,
    }, null, 2)}\n`);
  }

  const port = await freeGatewayPort();
  const gateway = spawnTrackedProcess(
    join(installation, "bin/butler-agent"),
    ["--installation-root", installation, "--resource-root", resources],
    {
      cwd: butlerData,
      stdio: ["pipe", "pipe", "pipe"],
      cleanupPaths: [scratch],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        TMPDIR: tmpdir(),
        BUTLER_DATA: butlerData,
        BUTLER_APP_FOREGROUND_LEASE: "1",
        BUTLER_APP_BUNDLED_SUPERVISOR: "1",
        BUTLER_APP_SERVER_HOST: "127.0.0.1",
        BUTLER_APP_SERVER_PORT: String(port),
        BUTLER_METRICS_ENABLED: "0",
        BUTLER_E2E_TIER: "stub",
        BUTLER_E2E_EMBED_SOURCES: "http://127.0.0.1:9",
        ...(options.devOrigins?.length ? { BUTLER_APP_DEV_ORIGIN: options.devOrigins.join(",") } : {}),
        ...options.env,
      },
    },
  );
  const child = gateway.child;
  const stop = async (): Promise<void> => {
    await gateway.stop();
    await new Promise<void>((done) => stub.server.close(() => done()));
  };
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  let token: string | null = null;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`Native gateway exited (${child.exitCode}):\n${output.slice(-4000)}`);
    }
    token ??= readLocalAuthToken(butlerData);
    try {
      if (token) {
        const response = await fetch(`${url}health`, { headers: { authorization: `Bearer ${token}` } });
        if (response.ok) {
          const readiness = await fetch(`${url}runtime-readiness`, { headers: { authorization: `Bearer ${token}` } });
          const reply = await readiness.json() as { data?: { authenticated_gateway_ready?: boolean; btcc_executor_ready?: boolean } };
          if (readiness.ok && reply.data?.authenticated_gateway_ready && reply.data.btcc_executor_ready) break;
        }
      }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`Native gateway did not become ready on ${url}:\n${output.slice(-4000)}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  if (options.onboardingComplete !== false && token) await completeAppOnboarding(url, token);

  const authHeaders = { authorization: `Bearer ${token}` };
  const connectUrl = async (): Promise<string> => {
    const response = await fetch(new URL("connection-codes", url), { method: "POST", headers: authHeaders });
    const body = await response.json().catch(() => null) as { data?: { url?: unknown } } | null;
    if (!response.ok || typeof body?.data?.url !== "string") {
      throw new Error(`POST /connection-codes -> ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data.url;
  };

  return {
    assertRunning() {
      if (child.exitCode !== null || child.signalCode !== null) {
        const tail = token ? output.slice(-4000).replaceAll(token, "[redacted]") : output.slice(-4000);
        throw new Error(`Native gateway exited: code=${child.exitCode}, signal=${child.signalCode}\n${tail}`);
      }
    },
    url,
    port,
    pid: gateway.pid,
    butlerData,
    stubModelCalls,
    token: token!,
    authHeaders,
    connectUrl,
    async signIn(target) {
      const jar = "addCookies" in target ? target : target.context();
      const response = await fetch(await connectUrl(), { redirect: "manual" });
      const pair = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (response.status !== 303 || separator <= 0) {
        throw new Error(`connection code was not redeemed (${response.status})`);
      }
      await jar.addCookies([{
        name: pair.slice(0, separator), value: pair.slice(separator + 1), url, httpOnly: true, sameSite: "Strict",
      }]);
    },
    async api<T>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await fetch(new URL(path.replace(/^\//u, ""), url), {
        ...init,
        headers: { "content-type": "application/json", ...authHeaders, ...(init.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
      const parsed = text ? JSON.parse(text) : null;
      return (parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed) as T;
    },
    stop,
  };
}
