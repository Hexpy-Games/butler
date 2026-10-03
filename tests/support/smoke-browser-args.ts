import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";

// Opt-in sandbox support, loaded with bun --preload; assertions stay unchanged.
const raw = process.env.BUTLER_SMOKE_BROWSER_ARGS;
if (raw) {
  const args: unknown = JSON.parse(raw);
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("BUTLER_SMOKE_BROWSER_ARGS must be a JSON array of strings");
  }
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (options = {}) => {
    const configured = { ...options, args: [...(options.args ?? []), ...args] };
    const browser = await launch(configured);
    // Chromium single-process exits when its context closes. Give each requested
    // context its own process, retaining Playwright's original context isolation.
    if (args.includes("--single-process")) isolateContexts(browser, configured, launch);
    return browser;
  };
}

function isolateContexts(browser: Browser, options: LaunchOptions, launch: (options: LaunchOptions) => Promise<Browser>) {
  const processes = new Set<Browser>();
  const closeBrowser = browser.close.bind(browser);
  const startTracing = browser.startTracing.bind(browser);
  const stopTracing = browser.stopTracing.bind(browser);
  let tracingBrowser: Browser | null = null;
  browser.startTracing = async (page, traceOptions) => {
    tracingBrowser = page?.context().browser() ?? null;
    return tracingBrowser && tracingBrowser !== browser
      ? tracingBrowser.startTracing(page, traceOptions) : startTracing(page, traceOptions);
  };
  browser.stopTracing = () => tracingBrowser && tracingBrowser !== browser
    ? tracingBrowser.stopTracing() : stopTracing();
  browser.newContext = async (contextOptions = {}) => {
    const isolated = await launch(options);
    processes.add(isolated);
    const context = await isolated.newContext(contextOptions);
    const closeContext = context.close.bind(context);
    context.close = async (closeOptions) => {
      try { await closeContext(closeOptions); } finally { await isolated.close(); processes.delete(isolated); }
    };
    return context;
  };
  browser.newPage = async (pageOptions = {}) => {
    const context: BrowserContext = await browser.newContext(pageOptions);
    const page = await context.newPage();
    const closePage = page.close.bind(page);
    page.close = async (closeOptions) => {
      try { await closePage(closeOptions); } finally { await context.close(); }
    };
    return page;
  };
  browser.close = async (closeOptions) => {
    await Promise.all([...processes].map((process) => process.close(closeOptions)));
    await closeBrowser(closeOptions);
  };
}
