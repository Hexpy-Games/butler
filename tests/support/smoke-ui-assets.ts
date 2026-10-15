import { resolve, extname, sep } from "node:path";
import type { Page } from "playwright";

/** Serve the current UI build when a reused gateway has an older asset catalog. */
export async function installSmokeUiAssets(page: Page, uiRoot: string): Promise<void> {
  const root = resolve(uiRoot);
  const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
    ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".json": "application/json" };
  await page.route("**/assets/**", async route => {
    const file = resolve(root, "." + new URL(route.request().url()).pathname);
    if (!file.startsWith(root + sep)) throw new Error("Smoke asset path escaped the UI build");
    const asset = Bun.file(file);
    if (!await asset.exists()) throw new Error(`Smoke UI asset missing: ${file}`);
    await route.fulfill({ contentType: types[extname(file)] ?? "application/octet-stream", body: Buffer.from(await asset.arrayBuffer()) });
  });
}
