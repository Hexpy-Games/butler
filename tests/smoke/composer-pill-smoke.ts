// UI behavior smoke: the actual DS blocks, served from the portable static build.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const root = resolve("packages/butler-app/client/ui/dist-ds-site");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname.replace(/^\/preview\//, "");
  if (path.includes("..")) return new Response(null, { status: 400 });
  return new Response(Bun.file(resolve(root, path || "index.html")));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const external: string[] = [];
  page.on("request", request => {
    if (!request.url().startsWith(`http://127.0.0.1:${server.port}/preview/`) && !request.url().startsWith("data:")) external.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.port}/preview/?page=blocks/ComposerCard&theme=light&locale=en`);
  const story = page.locator('[data-ds-story="Interactive composer"]');
  await story.waitFor({ state: "visible", timeout: 10_000 });
  const pill = story.locator('[data-slot="composer-controls"]');
  for (const state of ["idle", "typing", "streaming", "question", "attachments"]) {
    await story.getByLabel("Preview state", { exact: true }).selectOption(state);
    assert(await pill.isVisible(), `${state}: pill visible`);
    if (state === "question") {
      assert.equal(await story.locator('[data-slot="composer-expanded-body"]').getAttribute("inert"), "", "inactive folded editor is excluded from keyboard focus");
      assert(await pill.getByRole("button", { name: "Send", exact: true }).isDisabled(), "pill Send cannot submit answers");
    }
    for (const name of ["Attach", "Access: Ask", "Model: Luna", state === "streaming" ? "Stop" : "Send"]) {
      assert(await pill.getByRole("button", { name, exact: true }).isVisible(), `${state}: ${name}`);
    }
  }
  await story.getByLabel("Narrow 375").check();
  await story.getByLabel("Preview state", { exact: true }).selectOption("typing");
  assert(await pill.isVisible());
  const geometry = await story.locator('[data-slot="composer-preview-frame"]').evaluate(frame => {
    const input = frame.querySelector('[data-slot="composer-input"]')!.getBoundingClientRect();
    const controls = frame.querySelector('[data-slot="composer-controls"]')!.getBoundingClientRect();
    return { overflow: frame.scrollWidth - frame.clientWidth, gap: controls.top - input.bottom, width: controls.width,
      targets: [...frame.querySelectorAll('[data-slot="composer-controls"] button')].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) };
  });
  assert(geometry.overflow <= 1, JSON.stringify(geometry));
  assert.equal(geometry.gap, 8);
  assert(geometry.targets.every(target => target.width >= 44 && target.height >= 44), "all five narrow controls have 44px targets");
  await pill.getByRole("button", { name: "More", exact: true }).click();
  for (const name of ["Workspace", "Plan", "Context"]) assert(await page.locator('[data-slot="composer-overflow"]').getByLabel(name, { exact: true }).isVisible());
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "More");
  const editor = story.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("한글 draft\nComplete content");
  await editor.evaluate(element => { (window as unknown as { previewEditor: Element }).previewEditor = element; });
  for (const label of ["Dark theme", "Photo wallpaper", "Reduce motion"]) await story.getByLabel(label).check();
  assert(await editor.evaluate(element => element === (window as unknown as { previewEditor: Element }).previewEditor), "theme and motion keep the editor mounted");
  await editor.dispatchEvent("compositionstart");
  await editor.press("Enter");
  assert(await pill.getByRole("button", { name: "Send", exact: true }).isVisible(), "IME Enter must not send");
  await editor.dispatchEvent("compositionend");
  await editor.fill("한글 draft\nComplete content");
  await pill.getByRole("button", { name: "Send", exact: true }).click();
  await pill.getByRole("button", { name: "Stop", exact: true }).click();
  assert((await story.innerText()).includes("한글 draft Complete content") || (await story.innerText()).includes("한글 draft\nComplete content"));
  assert.deepEqual(external, [], "static preview makes no external/API requests");
  console.log(JSON.stringify({ ok: true, states: 5, geometry, externalRequests: external.length }));
} finally {
  await browser.close();
  await server.stop(true);
}
