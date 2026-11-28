import assert from "node:assert/strict";
import { textSizeFactor } from "../../packages/butler-app/client/ui/src/app/textSize.ts";
import type { ElectronPage } from "../../tests/support/electron-page-cdp.ts";
import { type App, type Locale, until, windowSetup } from "./app.ts";
import { getAppCopy, reasoningEffortLabel } from "../../packages/butler-i18n/src/index.ts";
import { demoModel, type Demo } from "./demo.ts";

const buttons = "button, [role=button]";
const sidebar = '[data-test-class="app-sidebar"]';
const sidebarItems = `${sidebar} :is(button, [role=button], a, [role=treeitem])`;
export const approval = '[data-test-class="composer-authority-decision"]';
const approvalCode = '[data-slot="composer-decision-code"] pre';
export const storeTextSize = "larger" as const;
export const storeScale = textSizeFactor(storeTextSize);

export function readApprovalCard(page: ElectronPage, allowLabel: string) {
  return page.expression<{ title: string; command?: string } | null>(`(() => {
    const panel = document.querySelector(${JSON.stringify(approval)});
    if (!panel?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
      panel.closest('[inert]') || panel.getAttribute('aria-busy') === 'true') return null;
    const allow = [...panel.querySelectorAll('button:not(:disabled, [aria-disabled=true])')].find(button =>
      (button.getAttribute('aria-label') || button.textContent)?.trim() === ${JSON.stringify(allowLabel)});
    if (!allow?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    return { title: panel.getAttribute('aria-label') ?? '', command: panel.querySelector(${JSON.stringify(approvalCode)})?.textContent?.trim() };
  })()`);
}

export async function click(page: ElectronPage, label: string, scope = buttons) {
  await page.waitForFunction(({ label, scope }) => [...document.querySelectorAll<HTMLElement>(scope)].some(node =>
    (node.getAttribute("aria-label") || node.textContent)?.trim() === label &&
    node.getBoundingClientRect().width > 0 && !node.matches(":disabled, [aria-disabled=true]") && !node.closest("[inert]"),
  ), { label, scope });
  await page.clickText(label, scope);
}

export async function clickSelector(page: ElectronPage, selector: string) {
  await page.waitForFunction(selector => {
    const element = document.querySelector(selector);
    return Boolean(element?.getBoundingClientRect().width && !element.matches(":disabled, [aria-disabled=true]"));
  }, selector);
  await page.clickSelector(selector);
}

export function textVisible(page: ElectronPage, text: string) {
  return page.waitForFunction(text => document.body.innerText.includes(text), text);
}

export function verifyTheme(page: ElectronPage, locale: Locale) {
  return page.waitForFunction(({ theme, language }) =>
    document.body.classList.contains(`theme-${theme}`) && document.documentElement.lang.split("-")[0] === language, locale);
}

export function verifyTextSize(page: ElectronPage) {
  return page.waitForFunction(scale =>
    getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim() === String(scale) &&
    Math.abs(devicePixelRatio - scale) < 0.01, storeScale);
}

export function waitInViewport(page: ElectronPage, ...targets: { selector: string; visibleOnly?: boolean; last?: boolean }[]) {
  return page.waitForFunction(targets => targets.every(({ selector, visibleOnly, last }) => {
    let elements = [...document.querySelectorAll(selector)];
    if (visibleOnly) elements = elements.filter(element => element.checkVisibility());
    if (last) elements = elements.slice(-1);
    return elements.length > 0 && elements.every(element => {
      const { width, left, top, right, bottom } = element.getBoundingClientRect();
      return width > 0 && left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight;
    });
  }), targets);
}

export async function firstRun(app: App, locale: Locale) {
  const { page } = app;
  const ko = locale.language === "ko";
  await app.ready();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-first-run-screen="welcome"]')));
  const result = await page.expression<{ ok: boolean }>(`window.butlerApp.updateSettings(${JSON.stringify({
    appearance_theme: locale.theme, text_size: storeTextSize,
  })})`);
  assert(result.ok, "Could not set the first-run theme and text size through the renderer bridge");
  if (await page.expression(`!document.body.classList.contains('theme-${locale.theme}') ||
    Math.abs(devicePixelRatio - ${storeScale}) >= 0.01`)) await page.reload();
  await page.waitForFunction(() => Boolean(document.querySelector("#first-run-language")));
  await verifyTextSize(page);
  await page.expression(`(() => {
    const field = document.querySelector('#first-run-language');
    const language = ${JSON.stringify(locale.language)};
    if (field.value === language) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, language);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await clickSelector(page, "#first-run-start");
  await click(page, ko ? "동의하고 계속" : "Agree and continue");
  await clickSelector(page, "[data-memory-choice=off]");
  await click(page, ko ? "계속" : "Continue", '[data-first-run-screen="memory"] button');
  const next = await until(() => page.expression<"vault" | "connect" | false>(`(() => {
    const step = document.querySelector('[data-first-run-screen]')?.dataset.firstRunScreen;
    return (step === 'vault' || step === 'connect') && step;
  })()`), "Vault or AI connection step");
  if (next === "vault") {
    await click(page, ko ? "사용 안 함" : "Don't use", '[data-first-run-screen="vault"] button');
    await click(page, ko ? "사용 안 함" : "Don't use", '[role="alertdialog"] button, [role="dialog"] button');
  }
  await textVisible(page, ko ? "어떤 AI와 일할까요?" : "Which AI should Butler use?");
  await waitInViewport(page, ...["chatgpt", "claude", "gemini"].map(id => ({
    selector: `[data-test-class="first-run-top-cards"] [data-card-id="${id}"]`,
  })));
}

export async function openChat(page: ElectronPage, title: string, prompt?: string) {
  await click(page, title, sidebarItems);
  if (prompt) await textVisible(page, prompt);
}

export async function organized(page: ElectronPage, words: Demo) {
  await openChat(page, words.A[0], words.A[1]);
  const table = '[data-test-class="message assistant"] table';
  await page.waitForFunction(table => Boolean(document.querySelector(table)), table);
  await page.expression(`document.querySelector(${JSON.stringify(table)}).scrollIntoView({ block: 'end', behavior: 'instant' })`);
  await page.waitForFunction(table => {
    const bounds = document.querySelector(table)?.getBoundingClientRect();
    return Boolean(bounds && bounds.width && bounds.top >= 0 && bounds.bottom <= innerHeight);
  }, table);
}

export async function pendingZip(page: ElectronPage, words: Demo, locale: Locale) {
  await openChat(page, words.B[0], words.B[1]);
  await page.waitForFunction(({ approval, approvalCode, command, label }) => {
    const panel = document.querySelector(approval);
    const bounds = panel?.getBoundingClientRect();
    const code = panel?.querySelector(approvalCode);
    return Boolean(bounds && bounds.width > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
      code && code.scrollWidth <= code.clientWidth + 1 && code.textContent?.trim() === command &&
      panel?.textContent?.includes(label));
  }, { approval, approvalCode, command: words.zip, label: getAppCopy(locale.locale).interfaceDetails.allowOnce });
}

export async function assertModelChip(page: ElectronPage, locale: Locale) {
  await waitInViewport(page, { selector: '[data-test-class="model-button"]' });
  const chip = await page.evaluate(() => document.querySelector<HTMLElement>('[data-test-class="model-button"]')?.innerText ?? "");
  assert(chip.includes(demoModel.display_name) && !chip.includes(reasoningEffortLabel("none", locale.locale)),
    `Unexpected composer model chip: ${JSON.stringify(chip)}`);
  return { modelChip: chip };
}

export async function openBrowserPane(page: ElectronPage) {
  const toggle = '[data-test-class="titlebar-browser-toggle"]';
  const area = "#butler-browser-area";
  if (!await page.expression(`Boolean(document.querySelector(${JSON.stringify(area)})?.getBoundingClientRect().width)`)) {
    await clickSelector(page, toggle);
  }
  await page.waitForFunction(area => Boolean(document.querySelector(area)?.getBoundingClientRect().width), area);
}

export async function browserShot(app: App, words: Demo) {
  const { page } = app;
  await openChat(page, words.C[0], words.C[1]);
  await openBrowserPane(page);
  await until(() => app.main.evaluate<boolean>(`(async () => {
    ${windowSetup}
    const contents = browserView()?.webContents;
    if (!contents) return false;
    const url = new URL(contents.getURL());
    if (url.hostname !== 'butler.hexpy.games' || url.pathname.replace(/\\/$/, '') !== ${JSON.stringify(words.helpPath + "scheduled-tasks")}) return false;
    return contents.executeJavaScript(${JSON.stringify(`document.body.innerText.includes(${JSON.stringify(words.newSchedule)})`)});
  })()`), "the Schedules manual in the visible Browser pane");
}

export async function assertBrowserStills(page: ElectronPage, locale: Locale) {
  const copy = getAppCopy(locale.locale).browser;
  const labels = [...Object.values(copy.stillFailure), copy.stillUnavailable];
  let state = { images: 0, loaded: 0, pending: false, failure: null as string | null };
  await until(async () => {
    state = await page.expression<typeof state>(`(() => {
      const stills = [...document.querySelectorAll('[data-test-class=browser-step-still]')];
      const images = stills.flatMap(node => [...node.querySelectorAll('img')]);
      const text = stills.filter(node => node.checkVisibility()).map(node => node.innerText).join(' ');
      return {
        images: images.length,
        loaded: images.filter(img => img.complete && img.naturalWidth > 0).length,
        pending: text.includes(${JSON.stringify(copy.stillPending)}),
        failure: ${JSON.stringify(labels)}.find(label => text.includes(label)) ?? null,
      };
    })()`);
    assert(!state.failure, `Chat C browser still failed: ${state.failure}`);
    return state.images > 0 && state.loaded === state.images && !state.pending;
  }, async () => `loaded chat C browser stills: ${JSON.stringify(state)}`);
  await waitInViewport(page,
    { selector: "[data-test-class=browser-step-still]", visibleOnly: true },
    { selector: '[data-test-class="message assistant"]', last: true });
  return { browserStills: state.images, answerInView: true };
}

export async function schedulesShot(page: ElectronPage, words: Demo, locale: Locale) {
  await click(page, words.navSchedules, sidebarItems);
  const view = '[data-test-class="automations-view"]';
  const general = getAppCopy(locale.locale).space.general;
  const rowSelector = `${view} [data-slot=clickable]`;
  await page.waitForFunction(({ view, titles }) => {
    const text = document.querySelector<HTMLElement>(view)?.innerText ?? "";
    return titles.every(title => text.includes(title));
  }, { view, titles: words.schedules.map(([title]) => title) });
  await waitInViewport(page, { selector: rowSelector });
  const rows = await page.expression<string[][]>(`[...document.querySelectorAll(${JSON.stringify(rowSelector)})]
    .map(row => row.innerText.split('\\n').map(line => line.trim()).filter(Boolean))`);
  assert.equal(rows.length, words.schedules.length, "Unexpected number of schedule rows");
  assert(!rows.some(lines => lines.includes("General")), 'Schedule list shows the unlocalized target "General"');
  for (const [index, [title]] of words.schedules.entries()) {
    const target = index === 1 ? words.A[0] : general;
    const row = rows.find(lines => lines[0] === title);
    assert.equal(row?.at(-1), target, `Unexpected target for schedule ${JSON.stringify(title)}`);
  }
}
