import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type CDPSession, type Page } from "playwright";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { smokeBrowserArgs } from "./smoke-browser-args";
export { smokeBrowserArgs } from "./smoke-browser-args";

/** Keep every matrix assertion, isolating Bun/CDP lifetimes on restricted runners. */
export async function runSmokeCases(cases: string[], variable: string, entry: string): Promise<boolean> {
  const selected = process.env[variable];
  if (selected) { assert(cases.includes(selected), `Unknown smoke case: ${selected}`); return false; }
  if (!smokeBrowserArgs().includes("--single-process")) return false;
  assert.equal(new Set(cases).size, cases.length);
  for (const cell of cases) {
    const isolation = mkdtempSync(join(tmpdir(), "butler-smoke-case-"));
    mkdirSync(join(isolation, "home")); mkdirSync(join(isolation, "data"));
    try {
      const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
        env: { ...process.env, HOME: join(isolation, "home"), BUTLER_DATA: join(isolation, "data"), [variable]: cell },
        stdio: "inherit",
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("exit", resolve);
      });
      assert.equal(code, 0, `Smoke case ${cell} failed`);
    } finally { rmSync(isolation, { recursive: true, force: true }); }
  }
  return true;
}

/** Electron needs its production process model; Chromium's restricted-runner
 * --single-process workaround crashes Electron 44 on macOS.
 */
export function smokeElectronArgs(): string[] {
  return parseSmokeArgs("BUTLER_SMOKE_ELECTRON_ARGS");
}

function parseSmokeArgs(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  const args: unknown = JSON.parse(raw);
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return args;
}

/** Chromium single-process cannot safely destroy and recreate contexts. Give
 * each context its own process, preserving storage isolation and all assertions.
 */
export async function launchSmokeBrowser(extraArgs: string[] = []): Promise<Browser> {
  const args = [...smokeBrowserArgs(), ...extraArgs];
  const channel = process.env.BUTLER_SMOKE_BROWSER_CHANNEL;
  if (channel && channel !== "chromium") throw new Error("BUTLER_SMOKE_BROWSER_CHANNEL must be chromium");
  const launch = { headless: true, args, ...(channel ? { channel } : {}) };
  const base = await chromium.launch(launch);
  if (!args.includes("--single-process")) return base;
  await boundOwnedClose(base);
  const owned = new Set<Browser>();
  let unusedBase = true;
  let tracingBrowser: Browser | undefined;
  async function newContext(options?: BrowserContextOptions): Promise<BrowserContext> {
    const browser = unusedBase ? base : await chromium.launch(launch);
    if (!unusedBase) await boundOwnedClose(browser);
    unusedBase = false;
    reportEventTracing(browser);
    owned.add(browser);
    try {
      const context = await browser.newContext(options);
      context.close = async () => { await browser.close(); owned.delete(browser); };
      return context;
    } catch (error) { await browser.close(); owned.delete(browser); throw error; }
  }
  const methods = {
    newContext,
    async newPage(options?: BrowserContextOptions): Promise<Page> {
      const context = await newContext(options);
      const page = await context.newPage();
      page.close = async () => context.close();
      return page;
    },
    contexts: () => [...owned].flatMap((browser) => browser.contexts()),
    async startTracing(page: Page, options: Parameters<Browser["startTracing"]>[1]) {
      tracingBrowser = page.context().browser()!;
      await tracingBrowser.startTracing(page, options);
    },
    async stopTracing() {
      if (!tracingBrowser) throw new Error("No smoke trace started");
      const result = await tracingBrowser.stopTracing(); tracingBrowser = undefined; return result;
    },
    async close() {
      const browsers = unusedBase ? [base] : [...owned];
      await Promise.all(browsers.map((browser) => browser.close())); owned.clear();
    },
  };
  return new Proxy(base, { get(target, key) {
    if (key in methods) return methods[key as keyof typeof methods];
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** ReportEvents has the same complete trace without single-process IO.read streams. */
function reportEventTracing(browser: Browser): void {
  let tracing: CDPSession | undefined;
  let events: unknown[] = [];
  browser.startTracing = async (page, options) => {
    tracing = page ? await page.context().newCDPSession(page) : await browser.newBrowserCDPSession(); events = [];
    tracing.on("Tracing.dataCollected", ({ value }) => events.push(...value));
    await tracing.send("Tracing.start", { categories: options?.categories?.join(","), transferMode: "ReportEvents" });
  };
  browser.stopTracing = async () => {
    if (!tracing) throw new Error("No smoke trace started");
    const session = tracing;
    const completed = new Promise<void>((done) => session.once("Tracing.tracingComplete", () => done()));
    await session.send("Tracing.end"); await completed; await session.detach(); tracing = undefined;
    return Buffer.from(JSON.stringify({ traceEvents: events }));
  };
}

/** The in-process Playwright bridge owns the Chromium child. Keep this pinned
 * adapter here: a CDP PID cannot tell us whether its pipes/cleanup have closed.
 */
export function ownedBrowserProcess(browser: Browser): ChildProcess {
  const local = browser as unknown as {
    _connection: { toImpl(browser: Browser): { options: { browserProcess: { process: ChildProcess } } } };
  };
  const child = local._connection.toImpl(browser).options.browserProcess.process;
  if (!Number.isSafeInteger(child.pid) || child.pid! <= 0 || !child.stdio) {
    throw new Error("Smoke browser ownership unavailable");
  }
  return child;
}

/** CDP read handles can keep Playwright waiting after
 * Chromium is gone. Destroy only our exited child's streams so close and profile
 * cleanup complete. Disconnection alone is not successful browser teardown.
 */
async function boundOwnedClose(browser: Browser): Promise<void> {
  const child = ownedBrowserProcess(browser);
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const releasePipes = () => { for (const stream of child.stdio) stream?.destroy(); };
  child.once("exit", releasePipes);
  if (exited()) releasePipes();
  const close = browser.close.bind(browser);
  let closing: Promise<void> | undefined;
  browser.close = (options) => closing ??= (async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        // Do not signal a stale CDP PID, or turn a forced live-process kill green.
        if (!exited()) {
          try { child.kill("SIGKILL"); }
          catch (error) { reject(error); return; }
        } else releasePipes();
        reject(new Error(`Owned smoke browser ${child.pid} did not close`));
      }, 9_500);
    });
    try { await Promise.race([close(options), stalled]); }
    finally { clearTimeout(deadline); }
  })();
}
