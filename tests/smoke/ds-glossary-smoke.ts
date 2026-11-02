// test-category: format-pin
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type Page } from "playwright";
import { parts } from "../../packages/butler-app/client/ui/src/libs/design-system/glossary/glossary";
import { probeFocusRing } from "../support/focus-ring-clipping";
import { launchSmokeBrowser } from "../support/smoke-browser";

// The standalone viewer uses the same page, navigation and search as the app,
// without requiring a native gateway for this data/documentation-only smoke.
const root = resolve("packages/butler-app/client/ui/dist-ds-site");
assert(await Bun.file(resolve(root, "index.html")).exists(), "Run npm --prefix packages/butler-app/client/ui run build:ds-site first");
const output = resolve(".tmp/ds-viewer/glossary");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!path.startsWith(root + sep)) return new Response(null, { status: 403 });
  const file = Bun.file(path);
  return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
} });

async function checkContents(page: Page): Promise<void> {
  assert.equal(await page.locator("[data-ds-glossary-area]").count(), 13);
  assert.equal(await page.locator("[data-ds-glossary-part]").count(), parts.length);
  for (const part of parts) {
    const node = page.locator(`[data-ds-glossary-part="${part.id}"]`);
    const direct = await node.locator(":scope > div").first().textContent();
    for (const text of [part.ko, part.en, part.desc, ...part.ds, ...part.app, ...part.avoid]) {
      assert(direct?.includes(text), `${part.id}: missing ${text}`);
    }
    const parent = await node.evaluate((element) => element.parentElement?.closest("[data-ds-glossary-part]")?.getAttribute("data-ds-glossary-part") ?? null);
    assert.equal(parent, part.parent, `Hierarchy for ${part.id}`);
    if (parent) {
      const offset = await node.evaluate((element) => element.getBoundingClientRect().left - element.parentElement!.closest("[data-ds-glossary-part]")!.getBoundingClientRect().left);
      assert(offset > 0, `Children of ${parent} must be visibly indented`);
    }
  }
  const overflow = await page.locator("[data-ds-glossary]").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > bounds.right + 1).length;
  });
  assert.equal(overflow, 0, "Glossary content overflows horizontally");
}

async function checkSearch(page: Page): Promise<number> {
  await page.keyboard.press("ControlOrMeta+k");
  const query = page.getByRole("combobox", { name: "Search the design system" });
  let count = 0;
  for (const part of parts) {
    for (const name of [part.ko, part.en, ...part.avoid]) {
      await query.fill(name);
      await page.getByRole("option").filter({ has: page.locator("small", { hasText: part.en }) }).filter({ hasText: part.ko }).first().waitFor();
      count += 1;
    }
  }
  await query.fill("traffic lights");
  await page.getByRole("option").filter({ hasText: "창 제어 영역" }).click();
  await page.waitForFunction(() => document.querySelector('[data-ds-glossary-part="window.traffic-lights"]')!.getBoundingClientRect().top < 200);
  // Secondary exports link to the owning item, too.
  await page.locator('[data-ds-glossary-part="composer.input"] button').filter({ hasText: "ComposerCardEditor" }).click();
  await page.locator('[data-ds-detail="ComposerCard"]').waitFor();
  return count;
}

const browser = await launchSmokeBrowser();
const images: string[] = [];
try {
  let searches = 0;
  for (const width of [1440, 320, 375, 390, 430]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 1000 : 812 } });
      try {
        for (const locale of ["ko", "en"]) {
          const params = new URLSearchParams({ page: "glossary", theme, locale, motion: "reduced" });
          await page.goto(`${server.url}?${params}`);
          await page.locator('[data-ds-glossary="156"]').waitFor();
          await checkContents(page);
          await page.locator('[data-ds-glossary-part="window"] button').first().focus();
          await page.keyboard.press("Tab");
          assert.deepEqual((await probeFocusRing(page))?.clips, [], "Glossary link focus ring is clipped");
          await page.locator('[data-ds-glossary-part="window"] button').nth(1).blur();
          await page.evaluate(async () => document.fonts.ready);
          const image = resolve(output, `${width}-${theme}-${locale}.png`);
          await page.screenshot({ path: image });
          images.push(image);
        }
        if (width === 1440 && theme === "light") {
          await page.locator("[data-ds-view-options]").click();
          await page.getByRole("radiogroup", { name: "Locale" }).getByRole("radio", { name: "KO", exact: true }).click();
          await page.keyboard.press("Escape");
          assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "용어 사전 / Glossary");
          await page.locator('[data-ds-nav-item="overview"]').click();
          await page.locator('[data-ds-nav-item="glossary"]').click();
          await page.locator('[data-ds-glossary="156"]').waitFor();
          searches = await checkSearch(page);
        }
      } finally { await page.close(); }
    }
  }
  console.log(JSON.stringify({ ok: true, parts: parts.length, searches, images }, null, 2));
} finally { await browser.close(); server.stop(true); }
