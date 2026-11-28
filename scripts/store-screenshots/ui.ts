import assert from "node:assert/strict";
import type { ElectronPage } from "../../tests/support/electron-page-cdp.ts";
import { type App, type Locale, until, windowSetup } from "./app.ts";
import type { demo } from "./demo.ts";

const buttons = "button, [role=button]";
const sidebar = '[data-test-class="app-sidebar"]';
const sidebarItems = `${sidebar} :is(button, [role=button], a, [role=treeitem])`;
export const approval = '[data-test-class="composer-authority-decision"]';
const instructions = '[data-settings-section-id="instructions"]';

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

export async function firstRun(app: App, locale: Locale) {
  const { page } = app;
  const ko = locale.language === "ko";
  await app.ready();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-first-run-screen="welcome"]')));
  const result = await page.expression<{ ok: boolean }>(`window.butlerApp.updateSettings({ appearance_theme: ${JSON.stringify(locale.theme)} })`);
  assert(result.ok, "Could not set the first-run theme through the renderer bridge");
  if (!await page.expression(`document.body.classList.contains('theme-${locale.theme}')`)) await page.reload();
  await page.waitForFunction(() => Boolean(document.querySelector("#first-run-language")));
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
  await page.waitForFunction(() => ["chatgpt", "claude", "gemini"].every(id =>
    document.querySelector(`[data-test-class="first-run-top-cards"] [data-card-id="${id}"]`)));
}

export async function openChat(page: ElectronPage, title: string, prompt?: string) {
  await click(page, title, sidebarItems);
  if (prompt) await textVisible(page, prompt);
}

export async function organized(page: ElectronPage, words: ReturnType<typeof demo>) {
  await openChat(page, words.A[0], words.A[1]);
  const table = '[data-test-class="message assistant"] table';
  await page.waitForFunction(table => Boolean(document.querySelector(table)), table);
  await page.expression(`document.querySelector(${JSON.stringify(table)}).scrollIntoView({ block: 'end', behavior: 'instant' })`);
  await page.waitForFunction(table => {
    const bounds = document.querySelector(table)?.getBoundingClientRect();
    return Boolean(bounds && bounds.width && bounds.top >= 0 && bounds.bottom <= innerHeight);
  }, table);
}

export async function pendingZip(page: ElectronPage, words: ReturnType<typeof demo>, locale: Locale) {
  await openChat(page, words.B[0], words.B[1]);
  await page.waitForFunction(({ approval, command, label }) => {
    const panel = document.querySelector(approval);
    const bounds = panel?.getBoundingClientRect();
    const code = panel?.querySelector('[data-slot="composer-decision-code"] pre');
    return Boolean(bounds && bounds.width > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
      code && code.scrollWidth <= code.clientWidth + 1 && code.textContent?.trim() === command &&
      panel?.textContent?.includes(label));
  }, { approval, command: words.zip, label: locale.language === "ko" ? "이번만 허용" : "Allow once" });
}

export async function browserShot(app: App, words: ReturnType<typeof demo>) {
  const { page } = app;
  await openChat(page, words.C[0], words.C[1]);
  const toggle = '[data-test-class="titlebar-browser-toggle"]';
  if (!await page.expression("Boolean(document.querySelector('#butler-browser-area')?.getBoundingClientRect().width)")) {
    await clickSelector(page, toggle);
  }
  await until(() => app.main.evaluate<boolean>(`(async () => {
    ${windowSetup}
    const contents = browserView()?.webContents;
    if (!contents) return false;
    const url = new URL(contents.getURL());
    if (url.hostname !== 'butler.hexpy.games' || url.pathname.replace(/\\/$/, '') !== ${JSON.stringify(words.helpPath + "scheduled-tasks")}) return false;
    return contents.executeJavaScript(${JSON.stringify(`document.body.innerText.includes(${JSON.stringify(words.newSchedule)})`)});
  })()`), "the Schedules manual in the visible Browser pane");
}

export async function schedulesShot(page: ElectronPage, words: ReturnType<typeof demo>) {
  await click(page, words.navSchedules, sidebarItems);
  for (const [title] of words.schedules) await textVisible(page, title);
}

export async function memoryShot(page: ElectronPage, words: ReturnType<typeof demo>, locale: Locale) {
  const ko = locale.language === "ko";
  await click(page, ko ? "설정" : "Settings");
  await click(page, ko ? "기억" : "Memory");
  await page.waitForFunction(({ instructions, rules }) => {
    const contents = (document.querySelector(instructions) as HTMLElement | null)?.innerText;
    const chat = document.querySelector('[data-settings-section-id="chat-memory"]');
    return rules.every(rule => contents?.includes(rule)) && Boolean(chat?.getBoundingClientRect().width);
  }, { instructions, rules: [...words.memory] });
  await page.expression(`document.querySelector(${JSON.stringify(instructions)}).scrollIntoView({ block: 'start', behavior: 'instant' })`);
}
