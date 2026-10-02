import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright";

/** Whitespace-separated Chromium flags for constrained smoke environments. */
export function smokeBrowserLaunchOptions(): LaunchOptions {
  return { headless: true, args: (process.env.BUTLER_SMOKE_BROWSER_ARGS ?? "").split(/\s+/u).filter(Boolean) };
}

/** Single-process Chromium needs one default profile per process. Each smoke
 * context gets a fresh temporary profile, preserving storage isolation. */
export async function launchSmokeBrowser(): Promise<Browser> {
  const options = smokeBrowserLaunchOptions();
  const browser = await chromium.launch(options);
  if (!options.args?.includes("--single-process")) return browser;
  const owned = new Set<BrowserContext>();
  const newContext = async (options?: Parameters<Browser["newContext"]>[0]): Promise<BrowserContext> => {
    if (process.env.BUTLER_SMOKE_DIAGNOSTICS) console.log("Chromium profile: launch");
    const context = await chromium.launchPersistentContext("", { ...smokeBrowserLaunchOptions(), ...options });
    if (process.env.BUTLER_SMOKE_DIAGNOSTICS) console.log("Chromium profile: ready");
    if (options?.storageState) await context.setStorageState(options.storageState);
    owned.add(context);
    let initialPage: Page | undefined = context.pages()[0];
    return new Proxy(context, {
      get(target, property) {
        if (property === "close") return async () => {
          if (process.env.BUTLER_SMOKE_DIAGNOSTICS) console.log("Chromium profile: close");
          await context.browser()!.close();
          if (process.env.BUTLER_SMOKE_DIAGNOSTICS) console.log("Chromium profile: closed");
          owned.delete(context);
        };
        if (property === "newPage") return async () => {
          if (initialPage) { const page = initialPage; initialPage = undefined; return page; }
          return target.newPage();
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(browser, {
    get(target, property) {
      if (property === "newContext") return newContext;
      if (property === "newPage") return async (options?: Parameters<Browser["newPage"]>[0]) => {
        const context = await newContext(options);
        const page = await context.newPage();
        // Close the owning browser directly: disposing its last page first
        // can deadlock Chromium in single-process mode.
        page.close = async () => { await context.close(); };
        return page;
      };
      if (property === "close") return async () => {
        await Promise.all([...owned].map((context) => context.browser()!.close()));
        owned.clear();
        await browser.close();
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
