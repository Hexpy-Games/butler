import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const sidebarSelector = '[data-test-class~="app-sidebar"]';
const cssPath = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "ui",
  "src",
  "libs",
  "design-system",
  "blocks",
  "SidebarShell",
  "SidebarShell.module.css",
);
const originalCss = readFileSync(cssPath, "utf8");
let vite: ChildProcess | null = null;

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry while Vite starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function stopVite(): void {
  if (!vite) return;
  vite.kill("SIGTERM");
  const child = vite;
  setTimeout(() => child.kill("SIGKILL"), 1500).unref();
  vite = null;
}

try {
  const port = await freePort();
  const uiUrl = `http://127.0.0.1:${port}`;
  vite = spawn("npm", [
    "--prefix",
    "packages/butler-app/client/ui",
    "run",
    "dev",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ], {
    cwd: root,
    stdio: "ignore",
  });

  await waitForHttp(uiUrl);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${uiUrl}/?visual=components`, { waitUntil: "networkidle" });
    await page.locator(sidebarSelector).waitFor({ state: "visible" });
    await page.waitForFunction((selector) => {
      const sidebar = document.querySelector(selector);
      return sidebar && getComputedStyle(sidebar).getPropertyValue("--butler-hmr-smoke").trim() === "";
    }, sidebarSelector);

    writeFileSync(cssPath, `${originalCss}\n:global([data-test-class~="app-sidebar"]) {\n  --butler-hmr-smoke: pass;\n}\n`, "utf8");
    await page.waitForFunction((selector) => {
      const sidebar = document.querySelector(selector);
      return sidebar && getComputedStyle(sidebar).getPropertyValue("--butler-hmr-smoke").trim() === "pass";
    }, sidebarSelector, { timeout: 10_000 });

    writeFileSync(cssPath, originalCss, "utf8");
    await page.waitForFunction((selector) => {
      const sidebar = document.querySelector(selector);
      return sidebar && getComputedStyle(sidebar).getPropertyValue("--butler-hmr-smoke").trim() === "";
    }, sidebarSelector, { timeout: 10_000 });

    console.log(JSON.stringify({
      ok: true,
      service: "butler-app-ui-hmr-smoke",
      checks: ["vite-dev-server-served", "css-module-hmr-applied", "css-module-hmr-removed"],
    }));
  } finally {
    await browser.close();
  }
} finally {
  writeFileSync(cssPath, originalCss, "utf8");
  stopVite();
}
