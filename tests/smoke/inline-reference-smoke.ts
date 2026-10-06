/** Product MessageMarkdown through a real gateway turn, with stub model and cached icon. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Response } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const host = "cached.invalid";
const markdown = `# [Heading](https://${host}/heading)

[Titled link](https://${host}/title), https://${host}/bare and https://${host}/${"long-path/".repeat(40)}.

[Unavailable](https://failed.invalid/) and [Mail](mailto:test@example.com).

| Source | Reference |
| --- | --- |
| Docs | [Table link](https://${host}/table) |`;
const temp = mkdtempSync(join(tmpdir(), "butler-inline-reference-"));
const cache = join(temp, "cache/favicons");
mkdirSync(cache, { recursive: true });
const iconPath = join(cache, `${createHash("sha256").update(host).digest("hex")}.png`);
writeFileSync(iconPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OIQEAAAgDsMciIL1PDMzE/DLbfoqAgICAgICAgICAgICAgMB34AAXEuiXWcJ0MQAAAABJRU5ErkJggg==", "base64"));
const output = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/inline-reference/after");
mkdirSync(output, { recursive: true });
const baseline = process.env.BUTLER_INLINE_BASELINE === "1";
const server = await createNativeAppServer({ butlerData: temp,
  uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
  config: { user: { name: "Smoke", language: "en" } }, stubReply: () => markdown });
const browser = await launchSmokeBrowser();
const reports: unknown[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await server.signIn(context);
  await context.addInitScript(() => {
    const sizes = new WeakMap<Element, number[]>();
    Object.defineProperty(window, "__faviconSizes", { value: sizes });
    new MutationObserver(() => {
      document.querySelectorAll('[data-slot="inline-reference-icon"]').forEach(icon => {
        if (!sizes.has(icon)) {
          const style = getComputedStyle(icon); sizes.set(icon, [parseFloat(style.width), parseFloat(style.height)]);
        }
      });
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-favicon"] });
  });
  const page = await context.newPage();
  for (const language of ["en", "ko"]) for (const theme of ["light", "dark"]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      if (page.url().startsWith(server.url)) await page.evaluate(() => localStorage.clear());
      await page.unrouteAll();
      const images: string[] = [];
      page.on("request", request => { if (request.resourceType() === "image") images.push(request.url()); });
      const iconResponses: Response[] = [];
      page.on("response", response => {
        if (response.url().includes("/favicons?host=cached.invalid")) iconResponses.push(response);
      });
      await page.route("**/favicons?host=failed.invalid", route => route.fulfill({ status: 404, headers: { "cache-control": "private, no-store" } }));
      await page.goto(server.url, { waitUntil: "load" });
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.fill("Show external references");
      const send = page.locator('[data-test-class="composer-send-button"]');
      console.log(JSON.stringify({ language, theme, width, sendWasDisabled: await send.isDisabled() }));
      await page.locator('[data-test-class="composer-send-button"]:not([disabled])').waitFor();
      const callsBefore = server.stubModelCalls.length;
      const repliesBefore = await page.locator('[data-test-class="markdown-document"]').count();
      await editor.press("ControlOrMeta+Enter");
      await page.waitForFunction(count => document.querySelectorAll('[data-test-class="markdown-document"]').length > count, repliesBefore);
      assert(server.stubModelCalls.length > callsBefore, "turn did not reach the stub model");
      const message = page.locator('[data-test-class="markdown-document"]').last();
      await message.getByText("Titled link", { exact: true }).waitFor();
      await message.getByText("Table link", { exact: true }).waitFor();
      if (!baseline) {
        assert.equal(await message.locator('a[data-kind="external"]').count(), 6);
        assert.equal(await message.locator('a[href^="mailto:"]:not([data-kind])').count(), 1);
        const loadingSizes = await message.locator('[data-slot="inline-reference-icon"]').evaluateAll(icons =>
          icons.map(icon => (window as typeof window & { __faviconSizes?: WeakMap<Element, number[]> }).__faviconSizes?.get(icon)));
        assert(loadingSizes.every(size => size?.length === 2 && size[0]! > 0 && size[1]! > 0), "initial icon geometry missing");
        await page.waitForFunction(() => {
          const icons = [...document.querySelectorAll('[data-test-class="markdown-document"] [data-slot="inline-reference-icon"]')];
          return icons.length > 0 && icons.every(icon => ["loaded", "fallback"].includes(icon.getAttribute("data-favicon") ?? ""));
        }, undefined, { timeout: 4000 });
        const loadedSizes = await message.locator('[data-slot="inline-reference-icon"]').evaluateAll(icons =>
          icons.map(icon => { const style = getComputedStyle(icon); return [parseFloat(style.width), parseFloat(style.height)]; }));
        assert.deepEqual(loadedSizes, loadingSizes, "favicon swap changed slot geometry");
        assert.equal(await message.locator('[data-favicon="loaded"]').count(), 5);
        assert.equal(await message.locator('[data-favicon="fallback"]').count(), 1);
        assert(iconResponses.length > 0, "no real favicon response");
        for (const response of iconResponses) {
          assert.equal(response.status(), 200, "stub favicon endpoint failed");
          assert.deepEqual(await response.body(), readFileSync(iconPath), "gateway changed fixture bytes");
        }
        const geometry = await message.evaluate(root => {
          const icons = [...root.querySelectorAll('[data-slot="inline-reference-icon"]')].map(node => {
            const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
          });
          const box = root.getBoundingClientRect();
          return { icons, overflow: root.scrollWidth - root.clientWidth,
            outside: [...root.querySelectorAll('a[data-kind="external"]')].some(node => [...node.getClientRects()].some(rect => rect.right > box.right + 1)) };
        });
        assert(geometry.overflow <= 1 && !geometry.outside, JSON.stringify(geometry));
        assert(geometry.icons.every(icon => Math.abs(icon.width - icon.height) < 1));
        assert(images.filter(url => url.includes("favicons")).every(url => new URL(url).origin === new URL(server.url).origin));
        assert(!images.some(url => [host, "failed.invalid"].includes(new URL(url).hostname)));
        reports.push({ width, theme, language, geometry, faviconRequests: images.filter(url => url.includes("favicons")).length });
      }
      await page.screenshot({ path: join(output, `${language}-${theme}-${width}.png`) });
      if (process.env.BUTLER_IDLE_OBSERVER && language === "ko" && theme === "dark" && width === 375) {
        await page.locator('[data-test-class="message assistant"]').last().locator('[data-test-class="assistant-footer"]').waitFor();
        const before = { mtime: statSync(iconPath).mtimeMs, bytes: readFileSync(iconPath).toString("base64") };
        const session = await page.context().browser()!.newBrowserCDPSession();
        const { processInfo } = await session.send("SystemInfo.getProcessInfo");
        await session.detach();
        const pid = processInfo.find((item: { type: string }) => item.type === "browser")?.id;
        assert(pid, "owned browser PID unavailable");
        await new Promise<void>((done, reject) => {
          const child = spawn(process.env.BUTLER_IDLE_OBSERVER!, [String(server.pid), String(pid)], { stdio: "inherit" });
          child.once("error", reject); child.once("exit", code => code === 0 ? done() : reject(new Error(`Idle observer exited ${code}`)));
        });
        assert.deepEqual({ mtime: statSync(iconPath).mtimeMs, bytes: readFileSync(iconPath).toString("base64") }, before);
      }
    }
  }
  writeFileSync(join(output, "report.json"), JSON.stringify({ baseline, cases: reports, modelCalls: server.stubModelCalls.length }, null, 2));
  console.log(JSON.stringify({ ok: true, baseline, cases: 8, modelCalls: server.stubModelCalls.length }));
} finally {
  try { await browser.close(); } finally { try { await server.stop(); } finally { rmSync(temp, { recursive: true, force: true }); } }
}
