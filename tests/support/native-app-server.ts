// Isolated native (Rust) App gateway for browser/Electron smokes.
//
// Replaces the retired in-process TypeScript `createAppServer` test composition.
// The executable is resolved from BUTLER_NATIVE_AGENT_EXECUTABLE (absolute) or the
// local release build. Each handle owns a temporary installation copy, BUTLER_DATA,
// HOME and CODEX_HOME, a private loopback port, and a stub OpenAI-compatible
// "Custom" model endpoint, so no real provider or live Butler state is touched.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type StubModelRequest = { stream: boolean; messages: unknown[]; body: Record<string, unknown> };

export type NativeAppServerOptions = {
  butlerData?: string;
  uiRoot?: string;
  config?: Record<string, unknown>;
  /** Marks first-chat onboarding complete before launch. Default true. */
  onboardingComplete?: boolean;
  stubReply?: (request: StubModelRequest) => string | Promise<string>;
  readyTimeoutMs?: number;
};

export type NativeAppServerHandle = {
  url: string;
  port: number;
  butlerData: string;
  stubModelCalls: StubModelRequest[];
  api<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  stop(): Promise<void>;
};

const repositoryRoot = resolve(import.meta.dir, "../..");

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

export function writeOnboardingComplete(butlerData: string): void {
  const now = new Date().toISOString();
  mkdirSync(join(butlerData, "personalization"), { recursive: true, mode: 0o700 });
  writeFileSync(join(butlerData, "personalization/onboarding.json"), `${JSON.stringify({
    schema: "butler.first_chat_onboarding.v1", status: "complete", gateway: "any", fields: {},
    skipped_fields: [], created_at: now, updated_at: now, completed_at: now,
  }, null, 2)}\n`, { mode: 0o600 });
}

async function startStubModel(
  reply: NativeAppServerOptions["stubReply"],
  calls: StubModelRequest[],
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
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!call.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `stub-${calls.length}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "stub",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage,
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: `stub-${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
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
  const stub = await startStubModel(options.stubReply, stubModelCalls);
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

  const port = await freePort();
  const child: ChildProcess = spawn(
    join(installation, "bin/butler-agent"),
    ["--installation-root", installation, "--resource-root", resources],
    {
      cwd: butlerData,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        TMPDIR: tmpdir(),
        BUTLER_DATA: butlerData,
        BUTLER_APP_SERVER_HOST: "127.0.0.1",
        BUTLER_APP_SERVER_PORT: String(port),
        BUTLER_METRICS_ENABLED: "0",
      },
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Native gateway exited (${child.exitCode}):\n${output.slice(-4000)}`);
    try {
      const response = await fetch(`${url}health`);
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`Native gateway did not become ready on ${url}:\n${output.slice(-4000)}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }

  return {
    url,
    port,
    butlerData,
    stubModelCalls,
    async api<T>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await fetch(new URL(path.replace(/^\//u, ""), url), {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
      const parsed = text ? JSON.parse(text) : null;
      return (parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed) as T;
    },
    async stop(): Promise<void> {
      if (child.exitCode === null) {
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        await exited;
        clearTimeout(timer);
      }
      await new Promise<void>((done) => stub.server.close(() => done()));
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
