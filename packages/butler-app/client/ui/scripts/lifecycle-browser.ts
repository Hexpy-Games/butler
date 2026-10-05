import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../../../../../tests/support/smoke-browser-args";

export const uiRoot = fileURLToPath(new URL("..", import.meta.url));
export async function lifecycleBrowser(entry = "/scripts/lifecycle-render.tsx", before = false) {
  const repository = resolve(uiRoot, "../../../..");
  const baseline = new Map<string, string>();
  if (before) {
    const changed = execFileSync("git", ["diff", "--name-only", "c0ac37e92", "--", "packages/butler-app/client/ui/src/libs/design-system"], { cwd: repository, encoding: "utf8" });
    for (const file of changed.trim().split("\n").filter(Boolean)) {
      const exists = execFileSync("git", ["ls-tree", "c0ac37e92", file], { cwd: repository, encoding: "utf8" });
      if (exists) baseline.set(resolve(repository, file), execFileSync("git", ["show", `c0ac37e92:${file}`], { cwd: repository, encoding: "utf8" }));
    }
  }
  const server = await createServer({
    root: uiRoot, configFile: false,
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    cacheDir: resolve(process.env.BUTLER_DATA!, "cache/lifecycle-vite"),
    optimizeDeps: { entries: [resolve(uiRoot, entry.slice(1))] },
    resolve: { alias: { "@/butler-ds": `${uiRoot}/src/libs/design-system`, "@": `${uiRoot}/src` } },
    plugins: [{ name: "lifecycle-before", enforce: "pre", load(id) { return baseline.get(id.split("?")[0]!); } }, react(), { name: "lifecycle-page", configureServer(server) {
      server.middlewares.use("/__lifecycle", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        const frame = entry.endsWith("lifecycle-render.tsx") ? "display:flex;width:360px;height:264px" : "";
        response.end(await server.transformIndexHtml("/__lifecycle", `<!doctype html><html><body><div id="root" style="${frame}"></div><script type="module" src="${entry}"></script></body></html>`));
      });
    } }],
  });
  await server.listen();
  let browser;
  try { browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() }); }
  catch (error) { await server.close(); throw error; }
  const address = server.httpServer!.address() as { port: number };
  return { browser, url: `http://127.0.0.1:${address.port}/__lifecycle`,
    async close() { await browser.close(); await server.close(); } };
}
