import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type CDPSession, type Page } from "playwright";

import { smokeBrowserArgs } from "./smoke-browser-args";
export { smokeBrowserArgs } from "./smoke-browser-args";

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
  const channel = process.env.BUTLER_SMOKE_BROWSER_CHANNEL === "chromium" ? "chromium" : undefined;
  const base = await chromium.launch({ headless: true, args, channel });
  if (!args.includes("--single-process")) return base;
  await boundOwnedClose(base);
  const owned = new Set<Browser>();
  let unusedBase = true;
  let tracingBrowser: Browser | undefined;
  async function newContext(options?: BrowserContextOptions): Promise<BrowserContext> {
    const browser = unusedBase ? base : await chromium.launch({ headless: true, args, channel });
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

/** Some sandboxed single-process builds hang closing iframe/GPU documents.
 * All assertions have finished when close is called; reap only this browser's
 * exact PID if its graceful teardown stalls. Verify exit within the same 10s
 * deadline even if the protocol close acknowledgement remains unresolved.
 */
async function boundOwnedClose(browser: Browser): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const owner = processInfo.find((process: { type: string }) => process.type === "browser");
  if (!owner || !Number.isSafeInteger(owner.id) || owner.id <= 0) throw new Error("Smoke browser ownership unavailable");
  const close = browser.close.bind(browser);
  let closing: Promise<void> | undefined;
  browser.close = (options) => closing ??= (async () => {
    if (!browser.isConnected()) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const disconnected = new Promise<void>(resolve => browser.once("disconnected", () => resolve()));
    const stalled = new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => {
        try { process.kill(owner.id, "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") { resolve(); return; }
          reject(error); return;
        }
        const expires = performance.now() + 500;
        const observe = () => {
          try { process.kill(owner.id, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") { resolve(); return; }
            reject(error); return;
          }
          if (performance.now() >= expires) { reject(new Error(`Owned smoke browser ${owner.id} did not exit`)); return; }
          setTimeout(observe, 10);
        };
        observe();
      }, 9_500);
    });
    try {
      await Promise.race([close(options), disconnected, stalled]);
    }
    finally { clearTimeout(deadline); }
  })();
}
