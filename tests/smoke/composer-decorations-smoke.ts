// UI harness: actual DS viewer, native input and Chromium IME; no model/provider.
import { chromium } from "playwright";
import { resolve } from "node:path";
import { smokeBrowserArgs } from "../support/smoke-browser";
import { checkDecorations, measureDecorations } from "../support/composer-decorations-checks";

const dist = resolve("packages/butler-app/client/ui/dist-ds-site");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  const file = resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
  return file.startsWith(`${dist}/`) ? new Response(Bun.file(file)) : new Response(null, { status: 403 });
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const density = Number(process.env.BUTLER_DECOR_DPR ?? 1);
  if (density !== 1 && density !== 2) throw new Error("BUTLER_DECOR_DPR must be 1 or 2");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: density });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?page=composer-decorations&theme=light`);
  await checkDecorations(page);
  await measureDecorations(page, density);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Composer decorations smoke passed; no page errors.");
} finally {
  await browser.close();
  server.stop(true);
}
