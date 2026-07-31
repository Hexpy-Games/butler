import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { assert } from "./scenario-preflight.ts";

export interface CdpClient {
  close(): void;
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpEvaluationResult {
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
  result?: { value?: unknown };
}

export class CdpPage {
  constructor(private readonly client: CdpClient) {}

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.client.send<CdpEvaluationResult>("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Renderer evaluation failed.",
      );
    }
    return result.result?.value as T;
  }

  async waitFor(
    expression: string,
    label: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (await this.evaluate<boolean>(expression)) return;
      } catch {
        // Navigation briefly invalidates the renderer JavaScript context.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    }
    throw new Error(`Timed out waiting for renderer ${label}.`);
  }

  async reload(): Promise<void> {
    await this.client.send("Page.reload", { ignoreCache: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    await this.waitFor(
      "document.readyState === 'interactive' || document.readyState === 'complete'",
      "reload",
      60_000,
    );
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.waitFor(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      `field ${selector}`,
    );
    const filled = await this.evaluate<boolean>(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      if (!(field instanceof HTMLTextAreaElement) && !(field instanceof HTMLInputElement)) {
        return false;
      }
      const prototype = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: ${JSON.stringify(value)},
        inputType: "insertText",
      }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return field.value === ${JSON.stringify(value)};
    })()`);
    assert(filled, `Renderer field fill failed: ${selector}`);
  }

  async clickSelector(selector: string): Promise<void> {
    await this.waitFor(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      `click target ${selector}`,
    );
    const clicked = await this.evaluate<boolean>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`);
    assert(clicked, `Renderer click failed: ${selector}`);
  }

  async clickButtonByName(name: string): Promise<void> {
    const lookup = `Array.from(document.querySelectorAll('button,[role="button"]')).find(
      (element) => element.getAttribute('aria-label')?.trim() === ${JSON.stringify(name)} ||
        element.textContent?.trim() === ${JSON.stringify(name)}
    )`;
    await this.waitFor(`Boolean(${lookup})`, `button ${name}`);
    const clicked = await this.evaluate<boolean>(`(() => {
      const element = ${lookup};
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`);
    assert(clicked, `Renderer button click failed: ${name}`);
  }

  async hasNamedElement(selector: string, name: string): Promise<boolean> {
    return await this.evaluate<boolean>(`Array.from(
      document.querySelectorAll(${JSON.stringify(selector)})
    ).some((element) =>
      element.getAttribute('aria-label')?.trim() === ${JSON.stringify(name)} ||
      element.textContent?.trim() === ${JSON.stringify(name)}
    )`);
  }

  async waitForNamedElement(selector: string, name: string): Promise<void> {
    await this.waitFor(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(
        (element) =>
          element.getAttribute('aria-label')?.trim() === ${JSON.stringify(name)} ||
          element.textContent?.trim() === ${JSON.stringify(name)}
      )`,
      `${selector} named ${name}`,
    );
  }

  async namedElementVisible(selector: string, name: string): Promise<boolean> {
    return await this.evaluate<boolean>(`Array.from(
      document.querySelectorAll(${JSON.stringify(selector)})
    ).some((element) => !element.closest('[aria-hidden="true"]') && (
      element.getAttribute('aria-label')?.trim() === ${JSON.stringify(name)} ||
      element.textContent?.trim() === ${JSON.stringify(name)}
    ))`);
  }

  async clickNamedElement(selector: string, name: string): Promise<void> {
    const lookup = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(
      (element) => !element.closest('[aria-hidden="true"]') && (
        element.getAttribute('aria-label')?.trim() === ${JSON.stringify(name)} ||
        element.textContent?.trim() === ${JSON.stringify(name)}
      )
    )`;
    await this.waitFor(`Boolean(${lookup})`, `${selector} named ${name}`);
    const clicked = await this.evaluate<boolean>(`(() => {
      const element = ${lookup};
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`);
    assert(clicked, `Renderer named element click failed: ${selector} / ${name}`);
  }

  async waitForNamedElementCurrent(selector: string, name: string): Promise<void> {
    await this.waitFor(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(
        (element) => (
          element.getAttribute('aria-label')?.trim() === ${JSON.stringify(name)} ||
          element.textContent?.trim() === ${JSON.stringify(name)}
        ) && element.getAttribute('aria-current') === 'page'
      )`,
      `${selector} named ${name} to become current`,
    );
  }

  async innerText(
    selector: string,
    options: { last?: boolean } = {},
  ): Promise<string> {
    const expression = options.last
      ? `(() => {
        const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        return elements.at(-1)?.innerText?.trim() ?? "";
      })()`
      : `document.querySelector(${JSON.stringify(selector)})?.innerText?.trim() ?? ""`;
    return await this.evaluate<string>(expression);
  }

  async screenshot(path: string): Promise<void> {
    const result = await this.client.send<{ data?: string }>("Page.captureScreenshot", {
      captureBeyondViewport: true,
      format: "png",
      fromSurface: true,
    });
    assert(result.data, "Renderer screenshot did not return image data.");
    writeFileSync(path, Buffer.from(result.data, "base64"));
  }
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
  }>();
  let nextId = 1;
  let closedError: Error | null = null;
  const rejectPending = (error: Error): void => {
    closedError ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(
      () => rejectOpen(new Error(`Timed out opening renderer CDP socket: ${url}`)),
      10_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error(`Failed to open renderer CDP socket: ${url}`));
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
      entry.reject(new Error(payload.error.message ?? "Renderer CDP command failed."));
    } else {
      entry.resolve(payload.result);
    }
  });
  socket.addEventListener("close", () => {
    rejectPending(new Error("Renderer CDP socket closed."));
  });
  socket.addEventListener("error", () => {
    rejectPending(new Error("Renderer CDP socket failed."));
  });
  return {
    close() {
      rejectPending(new Error("Renderer CDP socket closed."));
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    },
    send<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      if (closedError || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(closedError ?? new Error("Renderer CDP socket is not open."));
      }
      const id = nextId;
      nextId += 1;
      return new Promise<T>((resolveResult, reject) => {
        pending.set(id, {
          reject,
          resolve: (value) => resolveResult(value as T),
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

export async function connectElectronPage(
  debugPort: number,
  child: ChildProcess,
): Promise<{ client: CdpClient; page: CdpPage }> {
  const startedAt = Date.now();
  let lastError = "CDP endpoint is not ready.";
  while (Date.now() - startedAt < 120_000) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before its renderer was ready: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json() as CdpTarget[];
      const target = targets.find((candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl &&
        candidate.url !== "about:blank" &&
        !candidate.url?.startsWith("devtools://"),
      );
      if (target?.webSocketDebuggerUrl) {
        const client = await connectCdp(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        return { client, page: new CdpPage(client) };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Timed out connecting to Electron renderer: ${lastError}`);
}
