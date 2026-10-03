import "../support/smoke-browser-args";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";

// Behavior smoke: real product composer in the static viewer, in-memory actions only.
const root = resolve("packages/butler-app/client/ui/dist-ds-site");
const output = resolve(".tmp/composer-pill2");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  return new Response(Bun.file(resolve(root, path === "/" ? "index.html" : `.${path}`)));
} });
const browser = await chromium.launch({ headless: true });
const selector = (name: string) => `[data-test-class="${name}"]`;
const controls = ["attachment-button", "access-button", "composer-workspace-select", "composer-plan-mode-badge", "context-donut-button", "model-button"];

async function auditLayout(story: Locator) {
  const card = story.locator(selector("composer-card"));
  const row = story.locator(selector("composer-toolbar"));
  assert.equal(await card.locator(selector("composer-send-button")).count(), 1, "send stays inside card");
  assert.equal(await card.locator(selector("composer-toolbar")).count(), 0, "row is outside card");
  const order = await row.locator(controls.map(selector).join(",")).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-test-class")));
  assert.deepEqual(order, controls, "all original controls keep their order");
  for (const name of controls) {
    const control = row.locator(selector(name));
    assert(await control.isVisible(), `${name} visible`);
    assert.equal(await control.evaluate((element) => element.tagName), "BUTTON", `${name} is the actual button`);
    assert.equal(await control.locator("button").count(), 0, "no nested controls");
    assert.equal(await control.getAttribute("data-surface"), name === "context-donut-button" ? null : "glass-pill",
      `${name} uses its standard DS surface`);
    assert.equal(await control.locator('xpath=ancestor::*[@data-slot="composer-control-pill"]').count(), 0,
      "no polymorphic pill wrappers");
  }
  const geometry = await row.evaluate((element) => {
    const row = element.getBoundingClientRect();
    const card = element.closest('[data-test-class~="composer-wrap"]')!.querySelector('[data-test-class="composer-card"]')!.getBoundingClientRect();
    const pills = [...element.querySelectorAll('button[data-surface="glass-pill"]')].filter((pill) => pill.getBoundingClientRect().width);
    const centers = pills.map((pill) => { const box = pill.getBoundingClientRect(); return box.y + box.height / 2; });
    return { rowY: row.y, cardBottom: card.bottom, overflow: element.scrollWidth - element.clientWidth,
      centerDrift: Math.max(...centers) - Math.min(...centers),
      pills: pills.length, cardHeight: card.height, rowHeight: row.height, rowWidth: row.width };
  });
  assert(geometry.rowY >= geometry.cardBottom, "row lies below card");
  assert(geometry.overflow <= 1, `toolbar overflow: ${geometry.overflow}`);
  assert(geometry.centerDrift <= 1, `controls must stay on one line: ${geometry.centerDrift}px drift`);
  assert.equal(geometry.pills, 5);
  return geometry;
}

async function auditMenus(page: Page, story: Locator) {
  for (const name of ["attachment-button", "access-button", "composer-workspace-select", "context-donut-button", "model-button"]) {
    await story.locator(selector(name)).click();
    const menu = name === "composer-workspace-select" ? page.getByRole("listbox") : page.getByRole("dialog");
    await menu.waitFor();
    const trigger = story.locator(selector(name));
    assert.equal(await trigger.getAttribute("aria-expanded"), "true", `${name} retains menu trigger aria`);
    const anchor = await trigger.boundingBox();
    const popup = await menu.boundingBox();
    assert(anchor && popup && popup.x < anchor.x + anchor.width && popup.x + popup.width > anchor.x,
      `${name} retains its popover anchor ref`);
    const expected = name === "attachment-button" ? /Attach file/ : name === "access-button" ? /Ask/ : name === "composer-workspace-select" ? /Worktree/ : name === "context-donut-button" ? /53.8|53,760/ : /Review model/;
    assert.match(await menu.innerText(), expected, `${name} opens its real menu`);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await page.mouse.move(0, 0);
  }
  const workspace = story.locator(selector("composer-workspace-select"));
  await workspace.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Worktree", exact: true }).click();
  assert.match(await workspace.innerText(), /Worktree/, "existing workspace selection handler runs");
  await workspace.click();
  await page.getByRole("option", { name: "Local", exact: true }).click();
  await story.locator(selector("attachment-button")).click();
  await page.getByRole("button", { name: /Project documents/ }).click();
  await page.getByRole("button", { name: /Composer review/ }).click();
  await story.locator('[data-slot="attachment-item"]').filter({ hasText: "notes.txt" }).waitFor();
  await story.locator(selector("access-button")).click();
  const permission = page.getByRole("dialog").filter({ has: page.getByText("Full access", { exact: true }) });
  await permission.waitFor();
  await page.getByRole("heading", { name: "ComposerCard", exact: true }).first().click();
  await permission.waitFor({ state: "hidden" });
  await story.locator(selector("composer-plan-mode-badge")).click();
  assert.equal(await story.locator(selector("composer-plan-mode-badge")).count(), 0, "existing plan remove action works");
}

try {
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width: Math.max(768, width), height: 1000 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/?page=blocks/ComposerCard&width=${width <= 430 ? String(width) : "app"}&theme=dark&locale=en&motion=reduced`);
    const story = page.locator("[data-composer-review]");
    await story.locator(selector("model-button")).waitFor();
    const idle = await auditLayout(story);
    await story.screenshot({ path: `${output}/${width}-idle-dark-photo.png` });
    await story.getByLabel("Composer state").selectOption("typing");
    await story.locator('[contenteditable="true"]').getByText("Keep every existing control and menu.", { exact: false }).waitFor();
    const typing = await auditLayout(story);
    assert(typing.cardHeight > idle.cardHeight, "multiline grows input");
    await story.getByRole("switch", { name: "Attachments", exact: true }).click();
    await story.locator('[data-slot="attachment-item"]').filter({ hasText: "notes.txt" }).waitFor();
    await story.getByRole("switch", { name: "Question panel" }).click();
    await story.getByText("Where should I save it?").waitFor();
    await story.getByRole("switch", { name: "Question panel" }).click();
    await story.getByLabel("Composer state").selectOption("streaming");
    const stop = story.locator(selector("composer-card")).getByRole("button", { name: "Stop", exact: true });
    await stop.waitFor();
    await stop.click();
    await story.locator(selector("composer-card")).getByRole("button", { name: "Send", exact: true }).waitFor();
    await auditMenus(page, story);
    assert.deepEqual(errors, []);
    await story.screenshot({ path: `${output}/${width}-dark-photo.png` });
    console.log(JSON.stringify({ width, idle, typing, menus: 6, errors: 0 }));
    await page.close();
  }
} finally { await browser.close(); server.stop(true); }
