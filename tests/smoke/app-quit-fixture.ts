// Real App-owned Agent and deterministic local model; no provider credentials.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, nativeAgentExecutable, readLocalAuthToken, writeOnboardingComplete } from "../support/native-app-server.ts";

export async function quitFixture() {
  // Validate inputs before allocating the profile or starting a model server.
  readFileSync(resolve("packages/butler-app/client/ui/dist/index.html"));
  const root = mkdtempSync(join(tmpdir(), "butler-quit-smoke-"));
  const home = join(root, "home");
  const data = join(root, "data");
  const install = join(root, "install");
  for (const dir of [home, join(root, "appdata"), join(root, "local"), join(root, "temp")]) mkdirSync(dir, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(install, "bin"), { recursive: true });
  const binary = join(install, "bin", process.platform === "win32" ? "butler-agent.exe" : "butler-agent");
  cpSync(nativeAgentExecutable(), binary, { mode: 2 });
  cpSync(resolve("packages/butler-agent/resources"), join(install, "resources"), { recursive: true });
  cpSync(resolve("packages/butler-app/client/ui/dist"), join(install, "resources/app-client/dist"), { recursive: true });
  writeOnboardingComplete(data);
  let calls = 0;
  const model = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
      const body = await request.json() as { stream?: boolean };
      const first = ++calls === 1;
      const base = { id: `quit-${calls}`, object: "chat.completion.chunk", model: "stub" };
      const delta = (text: string) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
      if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "waiting" }, finish_reason: "stop" }] });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(delta(first ? "one" : "waiting")));
          if (!first) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({
    user: { name: "Smoke", language: "ko" }, system: { defaultModel: "local/stub" },
    models: { local: [{ model_id: "stub", display_name: "Stub", server_url: `http://127.0.0.1:${model.port}`, context_window_tokens: 128000 }] },
    metrics: { enabled: false },
  }));
  const port = await freePort();
  const inherited = new Set(["PATH", "TMPDIR", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "DISPLAY", "XAUTHORITY"]);
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => inherited.has(entry[0]) && typeof entry[1] === "string")),
    USERPROFILE: home, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "local"), TEMP: join(root, "temp"), TMP: join(root, "temp"),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", HOME: home, BUTLER_HOME: home, CODEX_HOME: join(home, ".codex"), BUTLER_DATA: data,
    BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0",
    BUTLER_NATIVE_AGENT_EXECUTABLE: binary, BUTLER_APP_SERVER_PORT: String(port),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"),
    BUTLER_E2E_TIER: "stub", BUTLER_E2E_EMBED_SOURCES: "http://127.0.0.1:9",
    BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1", BUTLER_METRICS_ENABLED: "0",
    BUTLER_PROVIDER_QUOTA_POLLING: "0",
  };
  const api = async (path: string, body?: unknown) => {
    const token = readLocalAuthToken(data);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`quit smoke ${path}: HTTP ${response.status}`);
    return (await response.json() as { data: Record<string, any> }).data;
  };
  return {
    root, data, env, api, calls: () => calls,
    lastExit: () => JSON.parse(readFileSync(join(data, "app/runtime/foreground/last-exit.json"), "utf8")),
    cleanup() { model.stop(true); rmSync(root, { recursive: true, force: true }); },
  };
}
