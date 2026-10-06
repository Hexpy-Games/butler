import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type CDPSession, type Page } from "playwright";

/** Explicit launch flags for restricted smoke runners; normal runs keep defaults. */
export function smokeBrowserArgs(): string[] {
  const raw = process.env.BUTLER_SMOKE_BROWSER_ARGS;
  if (!raw) return [];
  const args: unknown = JSON.parse(raw);
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("BUTLER_SMOKE_BROWSER_ARGS must be a JSON string array");
  }
  return args;
}

/** Chromium single-process cannot safely destroy and recreate contexts. Give
 * each context its own process, preserving storage isolation and all assertions.
 */
export async function launchSmokeBrowser(): Promise<Browser> {
  const args = smokeBrowserArgs();
  const base = await chromium.launch({ headless: true, args });
  if (!args.includes("--single-process")) return base;
  await boundOwnedClose(base);
  const owned = new Set<Browser>();
  let unusedBase = true;
  let tracingBrowser: Browser | undefined;
  async function newContext(options?: BrowserContextOptions): Promise<BrowserContext> {
    const browser = unusedBase ? base : await chromium.launch({ headless: true, args });
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
 * exact PID if its graceful teardown stalls, then let Playwright observe exit.
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
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<void>((done, reject) => {
      deadline = setTimeout(() => {
        try { process.kill(owner.id, "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") { done(); return; }
          reject(error); return;
        }
        reject(new Error(`Owned smoke browser ${owner.id} did not close`));
      }, 10_000);
    });
    try { await Promise.race([close(options), stalled]); }
    finally { clearTimeout(deadline); }
  })();
}
