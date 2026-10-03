import { smokeBrowserArgs } from "../support/smoke-browser-args";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";

// DS Viewer harness: static presenters, no gateway, owner data or model calls.
const root = resolve("packages/butler-app/client/ui/dist-ds-site");
const output = resolve(".tmp/decision-panel-review");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  return new Response(Bun.file(resolve(root, path === "/" ? "index.html" : `.${path}`)));
} });
const browser = await chromium.launch({ args: smokeBrowserArgs(), headless: true });
// Keep one context: Chromium single-process cannot safely dispose one of several contexts.
const context = await browser.newContext();
const base = `http://127.0.0.1:${server.port}/`;
const story = (page: Page, name: string) => page.locator(`[data-ds-story="${name}"]`).first();

async function geometry(panel: Locator) {
  return panel.evaluate((e) => {
    const header = e.querySelector('[data-slot="icon-slot"]')!.parentElement!;
    const icon = header.querySelector("svg")!.getBoundingClientRect();
    const caption = header.querySelector('[data-slot="typo"]') ?? header.querySelector("span");
    const css = getComputedStyle(header);
    const actions = e.querySelector('[data-slot="button-container"]')!;
    const footer = actions.parentElement!;
    return { inset: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft],
      icon: [icon.width, icon.height], captionOffset: icon.top - caption!.getBoundingClientRect().top,
      footerBorder: getComputedStyle(footer).borderTopWidth,
      end: footer.getBoundingClientRect().right - parseFloat(getComputedStyle(footer).paddingRight) - actions.getBoundingClientRect().right,
      radius: getComputedStyle(e).borderRadius };
  });
}
async function auditDecisionFeedback(page: Page, width: number, locale: string, theme: string) {
  for (const name of ["Plan decision", "Authority decision", "Failed decision"]) {
    const panel = story(page, name).locator('[tabindex="0"]').first();
    const measured = await panel.evaluate(e => {
      const header = e.querySelector('[data-slot="composer-decision-subject"]')!;
      const title = header.querySelector('[data-slot="clickable"] label')!;
      const eyebrow = header.querySelector('[data-tone="tertiary"]')!;
      const aside = header.querySelector('[data-slot="composer-decision-aside"] span');
      const error = e.querySelector('[role="alert"]');
      const footer = e.querySelector('[data-slot="composer-decision-actions"]')!;
      const css = getComputedStyle(error ?? header);
      return { gap: footer.getBoundingClientRect().top - (error ?? title).getBoundingClientRect().bottom,
        padding: css.paddingBottom, sm: getComputedStyle(e).getPropertyValue("--space-sm").trim(),
        errorInset: error ? error.getBoundingClientRect().left + parseFloat(css.paddingLeft) - title.getBoundingClientRect().left : 0,
        errorTop: error ? css.paddingTop : null, color: error ? getComputedStyle(error.querySelector("p")!).color : null,
        asideOffset: aside ? aside.getBoundingClientRect().top - eyebrow.getBoundingClientRect().top : 0,
        asideHeight: aside ? aside.getBoundingClientRect().height - eyebrow.getBoundingClientRect().height : 0 };
    });
    assert.equal(measured.padding, measured.sm, "content-to-footer spacing uses space-sm");
    assert(measured.gap >= 0, "content stays above divider");
    assert(Math.abs(measured.asideOffset) < 1 && Math.abs(measured.asideHeight) < 1, "pending count shares eyebrow baseline");
    if (name === "Failed decision") {
      assert(Math.abs(measured.errorInset) < 1, "error shares title text edge");
      assert.equal(measured.errorTop, measured.sm, "error has token spacing above");
      const danger = await panel.evaluate(e => {
        const probe = document.createElement("span"); probe.style.color = "var(--danger)"; e.append(probe);
        const color = getComputedStyle(probe).color; probe.remove(); return color;
      });
      assert.equal(measured.color, danger, "inline error uses FieldError danger tone");
      assert.equal(await panel.getByRole("alert").innerText(), locale === "ko" ? "결정을 전달하지 못했습니다." : "Could not submit the decision. Try again.");
    }
    await panel.screenshot({ path: `${output}/${name.replaceAll(" ", "-")}-${width}-${locale}-${theme}.png` });
  }
}
async function auditFocus(panel: Locator, page: Page) {
  await page.keyboard.press("Tab");
  for (const control of await panel.locator('button:enabled, [tabindex="0"]').all()) {
    await control.evaluate(e => e.scrollIntoView({ block: "center" }));
    await control.focus();
    assert.equal(await control.evaluate(e => {
      const css = getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      for (let p = e.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p), box = p.getBoundingClientRect();
        if (style.overflowX !== "visible" && (rect.left < box.left - 1 || rect.right > box.right + 1)) return false;
        if (style.overflowY !== "visible" && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) return false;
      }
      return e.matches(":focus-visible") && parseFloat(css.outlineOffset) < 0 && css.outlineStyle !== "none";
    }), true, "controls use visible inset focus");
  }
}
async function auditDetails(panel: Locator, page: Page, ko: boolean) {
  const scroll = panel.locator('[data-slot="decision-details-scroll"]');
  const detail = panel.locator('[data-slot="composer-decision-details"] p').first();
  const full = "Exact command " + "nested/".repeat(180) + " tail…";
  // ResizeObserver must react when the readable source content grows.
  await detail.evaluate((e, text) => { e.textContent = text; }, full);
  const more = panel.getByRole("button", { name: ko ? "더보기" : "Show more", exact: true });
  await more.waitFor();
  await more.click();
  assert.equal(await detail.textContent(), full);
  assert.equal(await detail.getAttribute("data-wrap"), "anywhere");
  assert.equal(await detail.getAttribute("data-truncate"), null);
  await page.waitForFunction(() => document.querySelector('[data-ds-story="High-risk command"] [data-overflowing="true"]'));
  for (const fraction of [0, 0.5, 1]) {
    await scroll.evaluate((e, f) => { e.scrollTop = (e.scrollHeight - e.clientHeight) * f; }, fraction);
    await page.waitForFunction(({ fraction }) => {
      const e = document.querySelector<HTMLElement>('[data-ds-story="High-risk command"] [data-slot="decision-details-scroll"]')!;
      return e.dataset.atStart === String(fraction === 0) && e.dataset.atEnd === String(fraction === 1);
    }, { fraction });
  }
  await panel.getByRole("button", { name: ko ? "접기" : "Show less", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-ds-story="High-risk command"] [data-slot="decision-details-scroll"]')?.getAttribute("data-overflowing") === "false");
}
async function keyboard(page: Page, ko: boolean) {
  const scope = story(page, "Keyboard · explicit confirmation");
  const panel = scope.locator('[aria-label][tabindex="0"]');
  await panel.focus(); await page.keyboard.press("Escape");
  assert.equal(await panel.count(), 1, "Escape retains approval");
  await page.keyboard.press("1");
  assert.equal(await panel.getByRole("button", { name: ko ? "거절" : "Deny", exact: true }).evaluate(e => e === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await scope.getByRole("status").count(), 0, "Escape never denies");
  await page.keyboard.press("2");
  assert.equal(await scope.getByRole("status").count(), 0, "number never approves");
  await page.keyboard.press("Enter");
  await scope.getByRole("status").waitFor();
  assert.equal(await scope.getByRole("status").textContent(), "Allowed");
  await page.reload(); await panel.waitFor();
  await panel.focus(); await page.keyboard.press("Enter");
  await scope.getByRole("status").waitFor();
  assert.equal(await scope.getByRole("status").textContent(), "Allowed", "Enter on frame confirms primary");
  await page.reload(); await panel.waitFor();
  await panel.focus(); await page.keyboard.press("1"); await page.keyboard.press("Enter");
  await scope.getByRole("status").waitFor();
  assert.equal(await scope.getByRole("status").textContent(), "Denied", "focused Deny needs explicit Enter");
}
async function motion() {
  for (const reduced of [false, true]) {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await page.goto(`${base}?page=blocks/ComposerDecisionPanel&motion=${reduced ? "reduced" : "full"}`);
    const scope = story(page, "Keyboard · explicit confirmation");
    const panel = scope.locator('[aria-label][tabindex="0"]');
    await panel.waitFor();
    await panel.getByRole("button").last().click();
    const frames = await panel.evaluate(e => e.getAnimations().flatMap(a => (a.effect as KeyframeEffect).getKeyframes()));
    assert(frames.length > 0, "explicit confirmation waits for shared exit motion");
    assert.equal(frames.some(f => Boolean(f.transform)), !reduced, "reduced motion removes displacement");
    await scope.getByRole("status").waitFor();
    assert.equal(await scope.getByRole("status").textContent(), "Allowed");
    await page.close();
  }
}
try {
  let renders = 0;
  for (const width of [375, 1280]) for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const query = `width=${width}&locale=${locale}&theme=${theme}&motion=reduced`;
    await page.goto(`${base}?page=blocks/ComposerQuestionPanel&${query}`);
    const question = story(page, "Single choice · recommended focus · Other").locator('[data-slot="composer-question-panel"]');
    await question.waitFor();
    const reference = await geometry(question);
    await question.screenshot({ path: `${output}/question-${width}-${locale}-${theme}.png` });
    await page.goto(`${base}?page=blocks/ComposerDecisionPanel&${query}`);
    const command = story(page, "High-risk command").locator('[tabindex="0"]').first();
    await command.waitFor();
    const actual = await geometry(command);
    assert.deepEqual(actual.inset, reference.inset); assert.deepEqual(actual.icon, reference.icon);
    assert.equal(actual.radius, reference.radius); assert.equal(actual.footerBorder, reference.footerBorder);
    assert(Math.abs(actual.end) < 1, "footer is end aligned");
    assert(Math.abs(actual.captionOffset - reference.captionOffset) < 1, "first-line icon rhythm agrees");
    assert.equal(await command.locator('[data-tone="danger"]').count(), 1);
    assert.equal(await page.getByRole("button", { name: /Compose a message first|먼저 메시지 작성|Later|나중에|Skip|건너뛰기/ }).count(), 0);
    await command.screenshot({ path: `${output}/decision-${width}-${locale}-${theme}.png` });
    await auditDecisionFeedback(page, width, locale, theme);
    await auditFocus(command, page); await auditDetails(command, page, locale === "ko"); await keyboard(page, locale === "ko");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no viewport overflow");
    await page.screenshot({ path: `${output}/${width}-${locale}-${theme}.png`, fullPage: true }); renders++;
    await page.close();
  }
  await motion();
  console.log(`PASS: ${renders} decision Viewer combinations; shared geometry, keyboard, wrapping, expand/collapse, risk, scroll edges, inset focus`);
} finally { await browser.close(); server.stop(true); }
