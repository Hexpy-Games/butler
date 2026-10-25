// test-category: race
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";

import { verifyInlineBleed, verifyInlineKeyboardRing } from "./inline-bleed-geometry.ts";

const review = process.env.BUTLER_INLINE_REVIEW_DIR ?? "/tmp/butler-inline-review";
type Field = "title" | "description";
const labels = { title: "제목", description: "설명" };
const triggers = { title: "제목 수정", description: "설명 편집" };
const detail = (page: Page) => page.locator('[data-test-class="canon-epic-detail"]:visible');
const trigger = (page: Page, field: Field) => detail(page).getByRole("button", { name: triggers[field], exact: true });
const input = (page: Page, field: Field) => detail(page).getByLabel(labels[field], { exact: true });
const dialog = (page: Page) => page.getByRole("alertdialog", { name: "변경 내용을 저장할까요?", exact: true });
const read = (server: NativeAppServerHandle, id: string) => server.api<EpicDetail>(`/canon/epics/${id}`);
const response = (page: Page, id: string) => page.waitForResponse(r => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/canon/epics/${id}`);

async function watchDialogs(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.inlineAlerts = "0";
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element) {
          const count = Number(node.matches('[role="alertdialog"]')) + node.querySelectorAll('[role="alertdialog"]').length;
          root.dataset.inlineAlerts = String(Number(root.dataset.inlineAlerts) + count);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("inline-observer-stop", () => observer.disconnect(), { once: true });
  });
}

async function noDialogs(page: Page) {
  assert.equal(await page.locator("html").getAttribute("data-inline-alerts"), "0", "No alertdialog mounted, including during save");
  assert.equal(await dialog(page).count(), 0);
  await page.evaluate(() => document.dispatchEvent(new Event("inline-observer-stop")));
}

async function capture(page: Page, theme: string, name: string) {
  mkdirSync(review, { recursive: true });
  const box = (await detail(page).boundingBox())!;
  await page.screenshot({ path: join(review, `${name}-${theme}.jpg`), type: "jpeg", quality: 80,
    clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(800, box.width + 16), height: Math.min(700, box.height + 16, page.viewportSize()!.height - box.y) } });
}

export async function verifyDelayedInlineSave(page: Page, server: NativeAppServerHandle, id: string, field: Field, theme?: string) {
  const value = field === "title" ? "릴리스 노트 정리 완료" : "변경 사항을 정리합니다.";
  await trigger(page, field).click();
  await input(page, field).fill(value);
  await watchDialogs(page);
  if (theme) await capture(page, theme, `${field}-editing`);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const requested = new Promise<void>(done => { started = done; });
  const url = `**/canon/epics/${id}`;
  const delay: Parameters<Page["route"]>[1] = async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    started(); await held; await route.continue();
  };
  await page.route(url, delay);
  try {
    const saved = response(page, id);
    await detail(page).getByRole("button", { name: "저장", exact: true }).click();
    await requested;
    const control = detail(page).getByRole("button", { name: "저장", exact: true });
    await page.waitForFunction(element => (element as HTMLButtonElement).disabled, await control.elementHandle());
    // Replay the browser's deferred focus loss from a disabled control after React commits.
    await control.evaluate(element => element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })));
    if (theme) await capture(page, theme, `${field}-saving-replay`);
    assert.equal(await dialog(page).count(), 0);
    release(); assert((await saved).ok());
    await trigger(page, field).waitFor();
    assert.equal((await read(server, id))[field], value);
    if (theme) await capture(page, theme, `${field}-saved`);
    await noDialogs(page);
  } finally { release(); await page.unroute(url, delay); }
}

async function verifyFailedSaveFocus(page: Page, id: string, field: Field) {
  await trigger(page, field).click(); await input(page, field).fill("저장 실패 후에도 유지할 초안");
  const url = `**/canon/epics/${id}`;
  const fail: Parameters<Page["route"]>[1] = route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, json: { error: "Save unavailable" } }) : route.continue();
  await page.route(url, fail);
  try {
    const failed = response(page, id);
    await detail(page).getByRole("button", { name: "저장", exact: true }).click();
    assert.equal((await failed).status(), 503);
    await page.waitForFunction(element => document.activeElement === element && !(element as HTMLInputElement).disabled,
      await input(page, field).elementHandle());
    assert.equal(await input(page, field).inputValue(), "저장 실패 후에도 유지할 초안");
    assert.equal(await dialog(page).count(), 0);
    await input(page, field).press("Escape");
  } finally { await page.unroute(url, fail); }
}

async function verifyCancelAndKeyboard(page: Page, server: NativeAppServerHandle, id: string, field: Field) {
  const before = (await read(server, id))[field];
  for (const cancel of ["button", "Escape"]) {
    await trigger(page, field).click(); await input(page, field).fill("버릴 초안");
    await watchDialogs(page);
    if (cancel === "button") await detail(page).getByRole("button", { name: "취소", exact: true }).click();
    else await input(page, field).press("Escape");
    await trigger(page, field).waitFor(); await noDialogs(page);
    assert.equal((await read(server, id))[field], before);
  }
  for (const key of field === "title" ? ["Enter"] : ["Meta+Enter", "Control+Enter"]) {
    const value = `${before} ${key}`;
    await trigger(page, field).click(); await input(page, field).fill(value);
    const saved = response(page, id); await input(page, field).press(key); assert((await saved).ok());
    await trigger(page, field).waitFor(); assert.equal((await read(server, id))[field], value);
  }
}

async function verifyExits(page: Page, field: Field) {
  for (const exit of ["outside", "switch", "task", "tab", "panel", "navigation"]) {
    await trigger(page, field).click(); await input(page, field).fill("편집 중인 초안");
    if (exit === "outside") {
      const area = page.locator('[data-session-section="task"]').getByText("과제", { exact: true });
      assert.equal(await area.evaluate(element => element.closest("button, a, input, textarea, [tabindex]")), null);
      await area.click();
    } else if (exit === "switch") await trigger(page, field === "title" ? "description" : "title").click();
    else if (exit === "task") await page.getByRole("button", { name: /전환할 과제/ }).first().click();
    else if (exit === "panel") await page.locator('[data-test-class="session-info-toggle"]').click();
    else if (exit === "navigation") await page.getByRole("button", { name: "설정", exact: true }).click();
    else {
      for (let index = 0; index < 8 && !await dialog(page).isVisible(); index++) await page.keyboard.press("Tab");
    }
    await dialog(page).waitFor();
    await dialog(page).getByRole("button", { name: "계속 편집", exact: true }).click();
    await page.waitForFunction(element => document.activeElement === element, await input(page, field).elementHandle());
    await input(page, field).press("Escape");
    await trigger(page, field).waitFor();
  }
}

async function geometry(target: Locator, editing = false) {
  return target.evaluate((element, editing) => {
    const box = element.getBoundingClientRect();
    if (editing) {
      const css = getComputedStyle(element), line = parseFloat(css.lineHeight), font = parseFloat(css.fontSize);
      const inset = parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop);
      const center = element.tagName === "INPUT" ? (element.clientHeight - line) / 2 : 0;
      return { height: box.height, y: box.y + inset + center + (line - font) / 2 };
    }
    const text = element.querySelector("h3, p")!;
    const range = document.createRange(); range.selectNodeContents(text);
    return { height: box.height, y: range.getClientRects()[0]!.y };
  }, editing);
}

async function verifyGeometry(page: Page, server: NativeAppServerHandle, id: string, theme: string) {
  const measurements = [];
  const original = await read(server, id);
  for (const name of ["title", "one", "two"]) {
    const field: Field = name === "title" ? "title" : "description";
    const value = name === "two" ? "변경 사항을 정리합니다.\n\n릴리스 노트를 검토합니다." : name === "one" ? "변경 사항을 정리합니다." : original.title;
    const current = await read(server, id);
    await server.api(`/canon/epics/${id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: current.revision, [field]: value }) });
    await detail(page).getByText(value.split("\n")[0]!, { exact: true }).waitFor();
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    const target = field === "title" ? trigger(page, field) : detail(page).getByRole("group", { name: triggers[field], exact: true });
    await target.scrollIntoViewIfNeeded();
    const rest = await verifyInlineBleed(target);
    if (name === "one") await capture(page, theme, "after-one-rest");
    await target.hover();
    await page.getByRole("tooltip", { name: triggers[field], exact: true }).waitFor();
    const hover = await verifyInlineBleed(target);
    assert.deepEqual(hover, rest, `${name}: hover height and first text y are exactly equal`);
    if (name !== "title") await capture(page, theme, `after-${name}-hover`);
    await verifyInlineKeyboardRing(trigger(page, field));
    await trigger(page, field).click();
    const edit = await geometry(input(page, field), true);
    measurements.push({ field, name, rest, hover, edit });
    await input(page, field).press("Escape");
  }
  const current = await read(server, id);
  await server.api(`/canon/epics/${id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: current.revision, title: original.title, description: original.description }) });
  writeFileSync(join(review, `after-measurements-${theme}.json`), JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({ inlineGeometry: measurements, theme }));
}

export async function verifySessionInlineEdit(page: Page, server: NativeAppServerHandle, id: string, theme: string) {
  const original = await read(server, id);
  const other = await server.api<EpicDetail>(`/projects/${original.project_id}/canon/epics`, {
    method: "POST", body: JSON.stringify({ title: "전환할 과제" }),
  });
  await server.api(`/canon/epics/${other.id}/conversation`, { method: "POST", body: "{}" });
  await verifyGeometry(page, server, id, theme);
  for (const field of ["description", "title"] as const) {
    await verifyDelayedInlineSave(page, server, id, field, theme);
    await verifyFailedSaveFocus(page, id, field);
    await verifyCancelAndKeyboard(page, server, id, field);
    await verifyExits(page, field);
  }
  const current = await read(server, id);
  await server.api(`/canon/epics/${id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: current.revision, title: original.title, description: original.description }) });
  console.log(`PASS session inline edit ${theme}: delayed save + deferred focusout, cancel, outside, field switch, Tab, panel, navigation, keyboard, exact hover geometry`);
}
