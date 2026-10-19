import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";

export interface CdpClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  close(): void;
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export async function connectToElectronPage(
  debugPort: number,
  appUrl: string,
  electronProcess: ChildProcess | null,
): Promise<CdpClient> {
  const origin = new URL(appUrl).origin;
  const startedAt = Date.now();
  let lastTargets: CdpTarget[] = [];
  while (Date.now() - startedAt < 60_000) {
    if (electronProcess && electronProcess.exitCode !== null) {
      throw new Error(
        `Electron exited before CDP target appeared: ${electronProcess.exitCode}`,
      );
    }
    try {
      const targets = (await fetch(`http://127.0.0.1:${debugPort}/json/list`)
        .then((response) => response.json())) as CdpTarget[];
      lastTargets = targets;
      const target = targets.find((item) =>
        item.type === "page" &&
        (
          item.url?.startsWith(origin) ||
          item.url?.startsWith("app://butler/") ||
          item.url?.endsWith("/app-client/index.html") ||
          item.url?.endsWith("/dist/index.html")
        ) &&
        item.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) {
        const client = await connectCdp(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        return client;
      }
    } catch {
      // Retry while Electron starts and exposes the renderer target.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const seen = lastTargets.map((item) => `${item.type ?? "?"} ${item.url ?? ""}`);
  throw new Error(
    `Timed out waiting for Electron page target at ${origin}. Last targets: ${JSON.stringify(seen)}`,
  );
}

export async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
  }>();
  let nextId = 1;
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(
      () => rejectOpen(new Error(`Timed out opening CDP socket: ${url}`)),
      10_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error(`Failed to open CDP socket: ${url}`));
    }, { once: true });
  });
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data)) as {
      error?: { message?: string };
      id?: number;
      result?: unknown;
    };
    if (!payload.id) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    if (payload.error) {
      entry.reject(new Error(payload.error.message ?? "CDP command failed."));
    } else {
      entry.resolve(payload.result);
    }
  });

  return {
    send<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      const id = nextId;
      nextId += 1;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          reject,
          resolve: (value) => resolve(value as T),
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
      for (const entry of pending.values()) {
        entry.reject(new Error("CDP socket closed."));
      }
      pending.clear();
    },
  };
}

export async function waitForExpression(
  client: CdpClient,
  expression: string,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluateBoolean(client, expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export async function evaluateBoolean(
  client: CdpClient,
  expression: string,
): Promise<boolean> {
  const result = await client.send<{
    exceptionDetails?: unknown;
    result?: { value?: unknown };
  }>("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) return false;
  return result.result?.value === true;
}

export async function evaluateString(
  client: CdpClient,
  expression: string,
): Promise<string> {
  const result = await client.send<{
    exceptionDetails?: unknown;
    result?: { value?: unknown };
  }>("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) return "";
  return typeof result.result?.value === "string" ? result.result.value : "";
}

/**
 * A control the user can reach: not in an inert copy of the previous step and
 * not under a running setup morph, which takes no clicks until it ends.
 */
const REACHABLE = "((element) => !element.closest('[inert],[data-morph]'))";

export async function clickButton(client: CdpClient, label: string): Promise<void> {
  const find = `Array.from(document.querySelectorAll("button,[role=button]")).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} && !candidate.disabled && ${REACHABLE}(candidate))`;
  await waitForExpression(client, `Boolean(${find})`, `button ${label}`);
  const clicked = await evaluateBoolean(
    client,
    `(() => {
      const button = ${find};
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  assert(clicked, `button click failed: ${label}`);
}

export async function fillInput(
  client: CdpClient,
  selector: string,
  value: string,
): Promise<void> {
  await waitForExpression(
    client,
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    `input ${selector}`,
  );
  const filled = await evaluateBoolean(
    client,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(value)} }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value === ${JSON.stringify(value)};
    })()`,
  );
  assert(filled, `input fill failed: ${selector}`);
}

export async function waitForHeading(
  client: CdpClient,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitForExpression(
    client,
    `Array.from(document.querySelectorAll("h1,h2,h3")).some((heading) => heading.textContent?.trim() === ${JSON.stringify(label)} && !heading.closest("[inert]"))`,
    `heading ${label}`,
    timeoutMs,
  );
}

export async function waitForText(
  client: CdpClient,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitForExpression(
    client,
    `document.body?.innerText?.includes(${JSON.stringify(label)}) === true`,
    `text ${label}`,
    timeoutMs,
  );
}
