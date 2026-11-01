// test-category: race
// The collapsed sidebar's peek stays open while the pointer goes from the left edge onto the sidebar toggle, and the toggle docks it.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert(output, "Set BUTLER_SMOKE_SCREENSHOTS to a temporary screenshot directory");
mkdirSync(output, { recursive: true });

const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
const page = await context.newPage();
await server.signIn(page);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));

const toggle = page.locator('[data-test-class="chrome-floating-toggle-layer"] button');
const sidebar = page.locator('[data-slot="adaptive-shell-sidebar"]');
const shell = page.locator('[data-slot="adaptive-shell-sidebar"]').locator("xpath=..");
const peeking = async () => (await shell.getAttribute("data-left-peek")) === "true";

async function shot(name: string) {
  await page.screenshot({ path: join(output!, `${name}.png`), clip: { x: 0, y: 0, width: 640, height: 480 } });
}

/** Moves the pointer through `points`, asserting the peek is open after every step and a dwell on the last one. */
async function glide(points: Array<[number, number]>, dwellMs: number) {
  for (const [x, y] of points) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(120);
    assert(await peeking(), `the peek closed with the pointer at ${x},${y}`);
  }
  // Longer than the peek's dismiss delay: a pointer resting on the toggle keeps it.
  await page.waitForTimeout(dwellMs);
  assert(await peeking(), "the peek closed while the pointer rested on the toggle");
}

async function exercise(theme: string) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: theme }) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.locator('[data-test-class="composer-card"]').waitFor();
  await page.mouse.move(640, 450);
  if ((await toggle.getAttribute("aria-label")) === "Hide sidebar") await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-slot="adaptive-shell-sidebar"]')?.getAttribute("data-open") === "false");
  assert.equal(await toggle.getAttribute("aria-label"), "Show sidebar");
  assert(!(await peeking()), "collapsed, nothing peeks");

  const box = (await toggle.boundingBox())!;
  const target: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(3, 300);
  await page.waitForFunction(() => document.querySelector('[data-slot="adaptive-shell-sidebar"]')?.parentElement?.getAttribute("data-left-peek") === "true");
  await shot(`${theme}-1-corner-hover`);
  await glide([[60, 200], [60, 90], [target[0] + 40, target[1] + 20], target], 700);
  const hit = await page.evaluate(([x, y]) => {
    const found = document.elementFromPoint(x, y);
    return Boolean(found?.closest('[data-test-class="chrome-floating-toggle-layer"] button'));
  }, target);
  assert(hit, "the toggle is the topmost element under the pointer");
  await shot(`${theme}-2-pointer-on-toggle`);

  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-slot="adaptive-shell-sidebar"]')?.getAttribute("data-open") === "true");
  assert.equal(await toggle.getAttribute("aria-label"), "Hide sidebar");
  assert(!(await peeking()), "docked, not peeking");
  assert((await sidebar.boundingBox())!.x >= 0);
  await shot(`${theme}-3-after-click`);
}

try {
  for (const theme of ["light", "dark"]) await exercise(theme);
  assert.deepEqual(errors, []);
  console.log("PASS");
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  await browser.close();
  await server.stop();
}
