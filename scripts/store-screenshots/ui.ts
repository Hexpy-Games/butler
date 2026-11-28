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
const request = '[data-test-class~="message"][data-test-class~="user"]';
const modelButton = '[data-test-class="model-button"]';
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

export function verifyTextSize(page: ElectronPage, devicePixelRatio: number) {
  return page.waitForFunction(({ uiScale, expectedRatio }) =>
    getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim() === uiScale &&
    Math.abs(window.devicePixelRatio - expectedRatio) < 0.01,
    { uiScale: String(storeScale), expectedRatio: devicePixelRatio });
}

function sidebarIsDocked(selector: string) {
  const panel = document.querySelector(selector);
  if (!panel?.closest('[data-panel-layout="docked"] #butler-left-sidebar[data-open="true"]') ||
    !panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const { width, left, right } = panel.getBoundingClientRect();
  return width > 0 && left >= 0 && right <= innerWidth;
}

export async function assertDesktopLayout(page: ElectronPage, withBrowser: boolean) {
  if (withBrowser) {
    await page.waitForFunction(() => {
      const browser = document.querySelector("#butler-browser-area")?.getBoundingClientRect();
      const chat = [...document.querySelectorAll('[data-test-class="message assistant"]')].at(-1)?.getBoundingClientRect();
      return Boolean(browser && browser.width > 0 && chat && chat.right <= browser.left);
    });
  } else {
    await page.waitForFunction(sidebarIsDocked, sidebar);
  }
  return page.expression<{ sidebarDocked: boolean; innerWidth: number }>(
    `({ sidebarDocked: (${sidebarIsDocked})(${JSON.stringify(sidebar)}), innerWidth })`,
  );
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
  const combinedScale = storeScale * app.displayScale;
  const ko = locale.language === "ko";
  await app.ready();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-first-run-screen="welcome"]')));
  const result = await page.expression<{ ok: boolean }>(`window.butlerApp.updateSettings(${JSON.stringify({
    appearance_theme: locale.theme, text_size: storeTextSize,
  })})`);
  assert(result.ok, "Could not set the first-run theme and text size through the renderer bridge");
  if (await page.expression(`!document.body.classList.contains('theme-${locale.theme}') ||
    Math.abs(devicePixelRatio - ${combinedScale}) >= 0.01`)) await page.reload();
  await page.waitForFunction(() => Boolean(document.querySelector("#first-run-language")));
  await verifyTextSize(page, combinedScale);
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

export async function closeBrowserPane(page: ElectronPage) {
  const area = "#butler-browser-area";
  if (await page.expression<boolean>(`Boolean(document.querySelector(${JSON.stringify(area)})?.getBoundingClientRect().width)`)) {
    await clickSelector(page, '[data-test-class="titlebar-browser-toggle"]');
    await page.waitForFunction(area => !document.querySelector(area)?.getBoundingClientRect().width, area);
  }
}

async function clickSidebar(page: ElectronPage, label: string) {
  // The app collapses the sidebar beside an open browser pane (run 46134374438); close the pane like a user.
  await closeBrowserPane(page);
  try {
    await page.waitForFunction(({ label, sidebarItems }) => {
      const nodes = [...document.querySelectorAll(sidebarItems)].filter(node =>
        (node.getAttribute("aria-label") || node.textContent)?.trim() === label);
      // Any match whose centre takes the click counts.
      const clickable = nodes.some(node => {
        const { left, top, width, height } = node.getBoundingClientRect();
        const x = left + width / 2, y = top + height / 2;
        // The row's label can sit beside the matched button (run 46135405598); any sidebar hit counts.
        return width > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight &&
          Boolean(node.closest("#butler-left-sidebar")?.contains(document.elementFromPoint(x, y)));
      });
      if (!clickable) nodes.find(node => node.getBoundingClientRect().width > 0)?.scrollIntoView({ block: "nearest" });
      return clickable;
    }, { label, sidebarItems });
  } catch (error) {
    const seen = await page.expression(`[...document.querySelectorAll(${JSON.stringify(sidebarItems)})].map(node => {
      const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: (node.getAttribute('aria-label') || node.textContent).trim().slice(0, 60), x: r.left, y: r.top, w: r.width, h: r.height,
        hit: hit && (hit.getAttribute('data-test-class') || hit.tagName) };
    })`).catch(() => null);
    throw new Error(`Sidebar row ${JSON.stringify(label)} did not take the click: ${JSON.stringify(seen)}`, { cause: error });
  }
  await page.clickText(label, sidebarItems);
}

export async function openChat(page: ElectronPage, title: string, prompt?: string) {
  await clickSidebar(page, title);
  if (prompt) await textVisible(page, prompt);
}

export async function organized(page: ElectronPage, words: Demo) {
  await openChat(page, words.A[0], words.A[1]);
  const table = '[data-test-class="message assistant"] table';
  await page.waitForFunction(table => Boolean(document.querySelector(table)), table);
  // Show the request and the whole result table together.
  await page.expression(`document.querySelector(${JSON.stringify(request)}).scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await waitInViewport(page, { selector: request }, { selector: table });
}

const requestSelectors = { request, approval, modelButton, buttons };
type RequestFrame = { requestTop: number; scrollerTop: number; panelBottom: number };

function requestFrame({ selectors, mode }: { selectors: typeof requestSelectors; mode: "scroll" | "check" | "measure" }) {
  const message = [...document.querySelectorAll(selectors.request)].at(-1);
  let scroll = message?.parentElement;
  while (scroll && (!(getComputedStyle(scroll).overflowY === "auto" || getComputedStyle(scroll).overflowY === "scroll") ||
    scroll.scrollHeight <= scroll.clientHeight)) scroll = scroll.parentElement;

  const rect = (node: Element | null | undefined) => {
    if (!node) return null;
    const { top, right, bottom, left } = node.getBoundingClientRect();
    return { top, right, bottom, left };
  };
  const bubble = rect(message);
  const bounds = rect(scroll);
  const scroller = scroll && bounds ? {
    top: bounds.top + scroll.clientTop, left: bounds.left + scroll.clientLeft,
    bottom: bounds.top + scroll.clientTop + scroll.clientHeight,
    right: bounds.left + scroll.clientLeft + scroll.clientWidth,
  } : null;
  if (mode === "scroll") {
    if (scroll && bubble && scroller) {
      const difference = scroller.top + 16 - bubble.top;
      if (difference > 0) scroll.scrollTo({ top: scroll.scrollTop - difference, behavior: "instant" });
    }
    return null;
  }

  const panelNode = document.querySelector(selectors.approval);
  const panel = rect(panelNode);
  const model = rect(document.querySelector(selectors.modelButton));
  const panelButtons = [...(panelNode?.querySelectorAll(selectors.buttons) ?? [])]
    .filter(button => button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).map(rect);
  const inside = (box: ReturnType<typeof rect>, area: NonNullable<ReturnType<typeof rect>>) =>
    box && box.right > box.left && box.bottom > box.top && box.left >= area.left &&
    box.top >= area.top && box.right <= area.right && box.bottom <= area.bottom;
  const viewport = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
  const frame: RequestFrame | null = bubble && scroller && panel && inside(bubble, scroller) &&
    inside(bubble, viewport) && bubble.bottom <= panel.top && inside(panel, viewport) &&
    panelButtons.every(button => inside(button, viewport)) && inside(model, viewport)
    ? { requestTop: bubble.top, scrollerTop: scroller.top, panelBottom: panel.bottom } : null;
  return mode === "check" ? frame : { frame, bubble, scroller, panel, panelButtons, modelButton: model, innerHeight };
}

export function frameRequest(page: ElectronPage) {
  return page.expression<null>(`(${requestFrame})(${JSON.stringify({ selectors: requestSelectors, mode: "scroll" })})`);
}

export async function requestFramed(page: ElectronPage): Promise<RequestFrame> {
  const measure = `(${requestFrame})(${JSON.stringify({ selectors: requestSelectors, mode: "measure" })})`;
  let cause: unknown;
  try {
    await page.waitForFunction(requestFrame, { selectors: requestSelectors, mode: "check" });
  } catch (error) {
    cause = error;
  }
  const measured = await page.expression<{ frame: RequestFrame | null }>(measure).catch(() => null);
  if (cause || !measured?.frame) {
    throw new Error(`Chat request framing failed: ${JSON.stringify(measured)}`, { cause });
  }
  return measured.frame;
}

export async function pendingZip(page: ElectronPage, words: Demo, locale: Locale) {
  await openChat(page, words.B[0], words.B[1]);
  try {
    await page.waitForFunction(({ approval, approvalCode, command, label }) => {
      const panel = document.querySelector(approval);
      const bounds = panel?.getBoundingClientRect();
      const code = panel?.querySelector(approvalCode);
      return Boolean(bounds && bounds.width > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
        code && code.scrollWidth <= code.clientWidth + 1 && code.textContent?.trim() === command &&
        panel?.textContent?.includes(label));
    }, { approval, approvalCode, command: words.zip, label: getAppCopy(locale.locale).interfaceDetails.allowOnce });
  } catch (error) {
    const box = (selector: string) => `(r => r && [r.left, r.top, r.right, r.bottom].map(Math.round))(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect())`;
    const seen = await page.expression(`({ panel: ${box(approval)}, workspace: ${box('[data-test-class="workspace"]')},
      browserArea: ${box("#butler-browser-area")}, innerWidth,
      code: (c => c && { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth })(document.querySelector(${JSON.stringify(`${approval} ${approvalCode}`)})) })`).catch(() => null);
    throw new Error(`Approval card check failed: ${JSON.stringify(seen)}`, { cause: error });
  }
  await frameRequest(page);
  await requestFramed(page);
}

export async function assertModelChip(page: ElectronPage, locale: Locale) {
  await waitInViewport(page, { selector: modelButton });
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
  await clickSidebar(page, words.navSchedules);
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
