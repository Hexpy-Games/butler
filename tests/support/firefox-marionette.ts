// Firefox driven through Marionette, including its privileged (chrome) context.
// Smokes need the chrome context for Gecko's TextInputProcessor, the same IME
// interface native IMEs use; WebDriver BiDi and Playwright cannot reach it.
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox } from "playwright";
import { freePort, spawnTrackedProcess, type TrackedProcess } from "./native-app-server.ts";

/** Minimal Marionette client: "<length>:<json>" frames over TCP. */
export class Marionette {
  private socket!: Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private context: "content" | "chrome" | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  static async connect(port: number, timeoutMs: number, alive: () => boolean = () => true): Promise<Marionette> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const client = new Marionette();
      try { await client.open(port); return client; } catch (error) {
        client.close();
        if (Date.now() > deadline || !alive()) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private open(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      this.socket = socket;
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
          const colon = this.buffer.indexOf(58);
          if (colon < 0) return;
          const length = Number(this.buffer.subarray(0, colon).toString());
          if (this.buffer.length < colon + 1 + length) return;
          const message = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString());
          this.buffer = this.buffer.subarray(colon + 1 + length);
          if (!Array.isArray(message)) { resolve(); continue; }
          const [, id, error, result] = message as [number, number, { error: string; message: string } | null, unknown];
          const waiter = this.pending.get(id);
          this.pending.delete(id);
          if (error) waiter?.reject(new Error(`${error.error}: ${error.message}`));
          else waiter?.resolve(result);
        }
      });
    });
  }

  send<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify([0, id, name, params]);
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    this.socket.write(`${Buffer.byteLength(body)}:${body}`);
    return result;
  }

  private async use(context: "content" | "chrome"): Promise<void> {
    if (this.context === context) return;
    await this.send("Marionette:SetContext", { value: context });
    this.context = context;
  }

  /** Runs a function body in the page (content) or the parent process (chrome). */
  async run<T = unknown>(context: "content" | "chrome", script: string, args: unknown[] = []): Promise<T> {
    await this.use(context);
    const result = await this.send<{ value: T }>("WebDriver:ExecuteScript", { script, args, ...(context === "chrome" ? { sandbox: "smoke", newSandbox: false } : {}) });
    return result.value;
  }

  async navigate(url: string): Promise<void> {
    await this.use("content");
    await this.send("WebDriver:Navigate", { url });
  }

  async click(x: number, y: number): Promise<void> {
    await this.use("content");
    await this.send("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport", duration: 0 },
      { type: "pointerDown", button: 0 }, { type: "pause", duration: 30 }, { type: "pointerUp", button: 0 },
    ] }] });
    await this.send("WebDriver:ReleaseActions", {});
  }

  close(): void { this.socket?.destroy(); }
}

export type MarionetteFirefox = { marionette: Marionette; version: string; close(): Promise<void> };

/**
 * Starts Firefox with Marionette: `BUTLER_SMOKE_FIREFOX` (a Firefox executable) or
 * Playwright's Firefox (`bunx playwright install firefox`). `BUTLER_SMOKE_FIREFOX_MARIONETTE`
 * attaches to a Firefox already started with `--marionette -remote-allow-system-access`
 * at that port, for runners whose sandbox keeps a child Firefox from starting.
 */
export async function launchMarionetteFirefox(): Promise<MarionetteFirefox> {
  const attachPort = process.env.BUTLER_SMOKE_FIREFOX_MARIONETTE;
  let owned: { process: TrackedProcess; log: string } | null = null;
  let marionette: Marionette;
  if (attachPort) {
    marionette = await Marionette.connect(Number(attachPort), 10_000);
  } else {
    const executable = process.env.BUTLER_SMOKE_FIREFOX || firefox.executablePath();
    if (!existsSync(executable)) {
      throw new Error(`Firefox not found at ${executable}. Run \`bunx playwright install firefox\` or set BUTLER_SMOKE_FIREFOX.`);
    }
    const profile = mkdtempSync(join(tmpdir(), "butler-smoke-firefox-"));
    const port = await freePort();
    const prefs: Record<string, number | boolean> = { "marionette.port": port, "browser.shell.checkDefaultBrowser": false,
      "datareporting.policy.dataSubmissionEnabled": false, "browser.aboutwelcome.enabled": false, "app.update.auto": false };
    writeFileSync(join(profile, "user.js"), Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${value});`).join("\n"));
    const log = join(profile, "firefox.log");
    const fd = openSync(log, "w");
    try {
      const process = spawnTrackedProcess(executable, ["-no-remote", "-headless", "-profile", profile, "--marionette", "-remote-allow-system-access"],
        { stdio: ["ignore", fd, fd], cleanupPaths: [profile] });
      owned = { process, log };
    } finally { closeSync(fd); }
    const child = owned.process.child;
    try {
      marionette = await Marionette.connect(port, 60_000, () => child.exitCode === null && child.signalCode === null);
    } catch (error) {
      const tail = existsSync(log) ? readFileSync(log, "utf8").slice(-3000) : "";
      await owned.process.stop(5_000);
      throw new Error(`Firefox ${executable} did not open Marionette: ${(error as Error).message}\n${tail}`, { cause: error });
    }
  }
  try {
    const session = await marionette.send<{ capabilities: { browserVersion: string } }>("WebDriver:NewSession", { capabilities: {} });
    await marionette.send("WebDriver:SetWindowRect", { width: 1280, height: 900 }).catch(() => undefined);
    return {
      marionette,
      version: session.capabilities.browserVersion,
      async close() {
        if (owned) await marionette.send("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => undefined);
        else await marionette.send("WebDriver:DeleteSession").catch(() => undefined);
        marionette.close();
        await owned?.process.stop(10_000);
      },
    };
  } catch (error) {
    marionette.close();
    await owned?.process.stop(5_000);
    throw error;
  }
}
