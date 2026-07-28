import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

const COMPOSER = '[data-test-class~="composer-card"]';
const TEXTAREA = `${COMPOSER} textarea`;
const SEND = `${COMPOSER} button[type="submit"]`;
const FINAL = 'article[data-test-class~="message"][data-test-class~="assistant"] ' +
  '[data-test-class~="markdown-document"]';
const FIRST_RUN_KEY = "butler:first-run-setup:v1";

type CdpClient = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
};

export async function launchWindowsAppBrowser(input: {
  repoRoot: string;
  serverUrl: string;
  dataRoot: string;
}) {
  if (process.platform !== "win32") {
    throw new Error("Windows App browser harness requires Windows");
  }
  const electronRoot = join(
    input.repoRoot,
    "packages",
    "butler-app",
    "client",
    "electron",
  );
  const electron = join(electronRoot, "node_modules", "electron", "dist", "electron.exe");
  const debugPort = await freePort();
  const profile = join(input.dataRoot, "electron-product-profile");
  const output: string[] = [];
  const child = spawn(electron, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    electronRoot,
  ], {
    cwd: input.repoRoot,
    env: {
      ...process.env,
      BUTLER_APP_SERVER_URL: input.serverUrl,
      BUTLER_APP_UI_URL: input.serverUrl,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: profile,
      BUTLER_DATA: input.dataRoot,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const cdp = await connectToPage(debugPort, input.serverUrl, child, output);
  await seedFirstRun(cdp);
  await waitFor(cdp, visible(TEXTAREA), "composer");
  return {
    async send(text: string) {
      await requireBoolean(cdp, `(() => {
        const element = document.querySelector(${JSON.stringify(TEXTAREA)});
        if (!(element instanceof HTMLTextAreaElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, "value"
        )?.set;
        setter?.call(element, ${JSON.stringify(text)});
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return element.value === ${JSON.stringify(text)};
      })()`);
      await waitFor(cdp, `(() => {
        const button = document.querySelector(${JSON.stringify(SEND)});
        return button instanceof HTMLButtonElement && !button.disabled;
      })()`, "send button");
      await requireBoolean(cdp, `(() => {
        const button = document.querySelector(${JSON.stringify(SEND)});
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
    },
    async waitForFinalCount(count: number) {
      await waitFor(
        cdp,
        `document.querySelectorAll(${JSON.stringify(FINAL)}).length >= ${count}`,
        `${count} assistant results`,
      );
      return await finalCount(cdp);
    },
    async reloadAndVerify(count: number) {
      await cdp.send("Page.reload", { ignoreCache: true });
      await waitFor(cdp, visible(TEXTAREA), "composer after reload");
      await waitFor(
        cdp,
        `document.querySelectorAll(${JSON.stringify(FINAL)}).length >= ${count}`,
        "assistant results after reload",
      );
      return await finalCount(cdp) === count;
    },
    async close() {
      cdp.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForExit(child);
    },
  };
}

async function seedFirstRun(client: CdpClient): Promise<void> {
  const state = JSON.stringify({
    schema: "butler.app.first-run.v1",
    status: "complete",
    language: "ko",
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "ready",
    connection_mode: "bundled-agent",
    completed_at: "2026-07-28T00:00:00.000Z",
  });
  const source = `localStorage.setItem(${JSON.stringify(FIRST_RUN_KEY)}, ${JSON.stringify(state)});`;
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await client.send("Runtime.evaluate", { expression: `${source} location.reload(); true` });
}

async function connectToPage(
  port: number,
  appUrl: string,
  child: ChildProcess,
  output: string[],
): Promise<CdpClient> {
  const origin = new URL(appUrl).origin;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron exited before renderer connection: ${safeOutput(output)}`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json()) as Array<{
          type?: string;
          url?: string;
          webSocketDebuggerUrl?: string;
        }>;
      const target = targets.find((item) =>
        item.type === "page" && item.url?.startsWith(origin) && item.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) {
        return await connectCdp(target.webSocketDebuggerUrl);
      }
    } catch {
      // Electron has not published the renderer target yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for Electron renderer: ${safeOutput(output)}`);
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  let nextId = 1;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? "CDP error"));
    else request.resolve(message.result);
  });
  const client: CdpClient = {
    send<T>(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
      });
    },
    close() {
      socket.close();
    },
  };
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  return client;
}

async function waitFor(
  client: CdpClient,
  expression: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluateBoolean(client, expression)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function requireBoolean(client: CdpClient, expression: string): Promise<void> {
  if (!await evaluateBoolean(client, expression)) {
    throw new Error("Electron renderer interaction was rejected");
  }
}

async function evaluateBoolean(client: CdpClient, expression: string): Promise<boolean> {
  const result = await client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.value === true;
}

async function finalCount(client: CdpClient): Promise<number> {
  const result = await client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression: `document.querySelectorAll(${JSON.stringify(FINAL)}).length`,
    returnByValue: true,
  });
  return typeof result.result?.value === "number" ? result.result.value : 0;
}

function visible(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
  })()`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function safeOutput(output: string[]): string {
  return output.join("").slice(-8_000);
}
