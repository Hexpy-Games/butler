import "../support/smoke-browser-args";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";

// Real DS stories: default compatibility and shared PillButton interaction states.
const root = resolve("packages/butler-app/client/ui/dist-ds-site");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  return new Response(Bun.file(resolve(root, path === "/" ? "index.html" : `.${path}`)));
} });
const browser = await chromium.launch({ headless: true });

async function stateStyles(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const read = async () => {
    // Read the settled state, not a frame partway through the DS transition.
    await button.evaluate(async (node) => {
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
    });
    return button.evaluate((node) => {
    const css = getComputedStyle(node);
    return { background: css.backgroundColor, border: css.border, shadow: css.boxShadow,
      scale: css.scale, opacity: css.opacity, cursor: css.cursor };
    });
  };
  const idle = await read();
  await button.hover();
  const hover = await read();
  await page.mouse.move(0, 0);
  await button.focus();
  assert(await button.evaluate((node) => node.matches(":focus-visible")));
  const focus = await read();
  await button.hover();
  await page.mouse.down();
  const pressed = await read();
  await page.mouse.up();
  await button.evaluate((node) => (node as HTMLElement).blur());
  return { idle, hover, focus, pressed };
}

try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${server.port}/?page=blocks/ContextDonutButton&theme=${theme}&motion=reduced`);
    const plain = page.locator('[data-ds-story="Plain surface"] button').first();
    const glassStory = page.locator('[data-ds-story="Glass surface"]');
    const glass = glassStory.locator("button").first();
    await plain.waitFor();
    assert.equal(await plain.getAttribute("data-surface"), null);
    assert.equal((await plain.boundingBox())!.height, 30, "default trigger stays 30px");
    assert.equal(await glass.getAttribute("data-surface"), "glass-pill");
    const states = await stateStyles(page, glass);
    assert.notEqual(states.idle.background, states.hover.background);
    assert.notEqual(states.idle.shadow, states.focus.shadow);
    assert(await glassStory.locator("button:disabled").isDisabled());
    const ring = await glass.locator("svg").boundingBox();
    assert.equal(ring!.width, 18); assert.equal(ring!.height, 18);
    await glassStory.screenshot({ path: `.tmp/composer-pill2/context-glass-${theme}.png` });
    await plain.screenshot({ path: `.tmp/composer-pill2/context-plain-${theme}.png` });
    await page.goto(`http://127.0.0.1:${server.port}/?page=blocks/ComposerCard&theme=${theme}&motion=reduced`);
    const peer = page.locator('[data-composer-review] [data-test-class="attachment-button"]');
    await peer.waitFor();
    const peerStates = await stateStyles(page, peer);
    assert.deepEqual(states, peerStates, "glass donut shares every PillButton interaction state");
    console.log(JSON.stringify({ theme, plainHeight: 30, ring: [18, 18], sharedStates: Object.keys(states) }));
    await page.close();
  }
} finally { await browser.close(); server.stop(true); }
