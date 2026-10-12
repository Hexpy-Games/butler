// Product UI smoke using the message reopened by the stub integration E2E.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser } from "../support/smoke-browser";

const root = process.cwd();
const before = process.env.BUTLER_ANSWER_STAGE === "before";
const baseline = new Map<string, string>();
const baselineRevision = process.env.BUTLER_ANSWER_BASELINE;
if (before) assert(baselineRevision, "BUTLER_ANSWER_BASELINE is required for before captures");
if (before) for (const file of ["packages/butler-app/client/shared/answer-blocks-parse.ts",
  "packages/butler-app/client/ui/src/components/conversation/AnswerCards.tsx",
  "packages/butler-app/client/ui/src/components/conversation/AnswerDataBlocks.tsx"]) {
  baseline.set(resolve(root, file), execFileSync("git", ["show", `${baselineRevision}:${file}`], { encoding: "utf8" }));
}
const evidence = process.env.BUTLER_ANSWER_EVIDENCE!;
assert(evidence, "BUTLER_ANSWER_EVIDENCE is required");
mkdirSync(evidence, { recursive: true });
const message = JSON.parse(readFileSync(join(evidence, "reopened-message.json"), "utf8"));
const items = message.answer_blocks[0].spec.blocks[0].items;
const images = new Map<string, Buffer>(items.map((item: { image_url: string }, index: number) =>
  [item.image_url, readFileSync(join(evidence, index === 0 ? "first.jpg" : "second.jpg"))]));
process.chdir(resolve(root, "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  plugins: [{ name: "answer-integration-baseline", enforce: "pre", load(id) { return baseline.get(id.split("?")[0]); } }],
});
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
const errors: string[] = [];
const cells: unknown[] = [];
let assetsDeleted = false;
try {
  for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      Object.assign(window, { butlerBrowser: {
        call: async () => ({ enabled: false, blocked: false, tabs: [], activeId: null }),
        subscribe: () => () => {}, onElementDrag: () => () => {}, onSelectionAction: () => () => {}, onDownload: () => () => {},
      } });
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (url.pathname === "/") {
        const response = await route.fetch();
        const fixture = JSON.stringify({ messages: [message], background: "plain" }).replaceAll("<", "\\u003c");
        return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${fixture}</script>`) });
      }
      if (url.pathname.startsWith("/assets/")) {
        const image = assetsDeleted ? undefined : images.get(url.pathname + url.search);
        return image ? route.fulfill({ contentType: "image/jpeg", body: image }) : route.fulfill({ status: 404 });
      }
      if (url.pathname.startsWith("/message-files/")) return route.fulfill({ contentType: "image/jpeg", body: readFileSync(join(evidence, "first.jpg")) });
      if (url.pathname === "/favicons") return route.fulfill({ status: 404 });
      if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: {
        session_id: "general", revision: 0, catalog_generation: "harness-model-catalog-v1",
        controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false },
      } } });
      if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
      if (url.pathname === "/session-view") return route.fulfill({ json: { ok: true, data: { messages: [message] } } });
      if (["/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
      return route.continue();
    });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
    const blocks = page.locator('[data-test-class="answer-blocks"]');
    await blocks.waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (before) {
      await page.waitForFunction(() => document.querySelectorAll('[data-test-class="answer-blocks"] [data-fit="failed"]').length === 4);
      await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: join(evidence, `before-collected-${width}-${theme}.png`) });
      await page.close();
      continue;
    }
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll<HTMLImageElement>('[data-test-class="answer-blocks"] [data-slot="media-frame"] img')];
      return images.length === 4 && images.every(image => image.complete && image.naturalWidth > 0);
    });
    assert.equal(await page.locator('[data-slot="item-card"]').count(), 2);
    assert.equal(await blocks.locator("tbody tr").count(), 2);
    assert.equal(await blocks.locator('[data-fit="empty"], [data-fit="failed"]').count(), 0);
    assert((await blocks.innerText()).includes("2 items"));
    const geometry = await blocks.evaluate(node => ({ width: node.getBoundingClientRect().width,
      images: [...node.querySelectorAll<HTMLImageElement>("[data-slot=media-frame] img")].map(image => ({ width: image.naturalWidth, height: image.naturalHeight, renderedWidth: image.getBoundingClientRect().width, renderedHeight: image.getBoundingClientRect().height })) }));
    assert(geometry.width <= width);
    assert(geometry.images.every(image => image.renderedWidth > 0 && image.renderedHeight > 0), "all card and gallery pixels are visible");
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: join(evidence, `collected-${width}-${theme}.png`) });
    // Deleted assets retain the same frame without exposing a broken image.
    assetsDeleted = true;
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-test-class="answer-blocks"] [data-fit="failed"]').length === 4).catch(async error => {
      writeFileSync(join(evidence, "deleted-state.json"), JSON.stringify(await blocks.locator('[data-slot="media-frame"]').evaluateAll(nodes => nodes.map(node => ({ fit: node.getAttribute("data-fit"), html: node.innerHTML }))), null, 2));
      throw error;
    });
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: join(evidence, `deleted-${width}-${theme}.png`) });
    cells.push({ width, theme, cards: 2, images: 4, rows: 2, deletedFrames: 4, geometry });
    await page.close();
    assetsDeleted = false;
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, before ? "before-collected-ui-result.json" : "collected-ui-result.json"), JSON.stringify({ ok: true, cells, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, cells, modelCalls: 0 }));
} finally { await browser.close(); await vite.close(); }
