import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { waitBrowser, type browserAgentApp } from "./browser-agent-app";

export type ShellApp = Awaited<ReturnType<typeof browserAgentApp>>;
export const toggle = '[data-test-class="titlebar-browser-toggle"]';
export const pane = '[data-slot="browser-pane"]';

export async function shellReady(app: ShellApp, locale: string) {
  await waitBrowser(() => app.page.expression(`document.documentElement.lang === ${JSON.stringify(locale === "ko" ? "ko-KR" : "en-US")} &&
    [...document.querySelectorAll('[data-test-class="app-sidebar"] *')].some(n => n.textContent?.trim() === ${JSON.stringify(locale === "ko" ? "일반" : "General")})`), "localized navigation loaded");
}

export async function togglePane(app: ShellApp, open: boolean) {
  await app.page.clickSelector(toggle);
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${pane}')) === ${open}`), "pane toggle");
  assert.equal(await app.page.expression(`document.querySelector('${toggle}').getAttribute('aria-pressed')`), String(open));
}

export async function toggleState(app: ShellApp, tone: string | null, dot: boolean) {
  await waitBrowser(() => app.page.expression(`document.querySelector('${toggle}')?.getAttribute('data-tone') === ${JSON.stringify(tone)} &&
    Boolean(document.querySelector('${toggle} [data-slot="icon-button-indicator"]')) === ${dot}`), "browser icon state");
  assert.equal(await app.page.expression(`document.querySelector('${toggle}').hasAttribute('data-selected')`), false);
}

export async function nativeAligned(app: ShellApp) {
  await waitBrowser(() => app.page.expression("!document.querySelector('[data-slot=browser-pane]').getAnimations({subtree:true}).some(a=>a.playState==='running') && !document.querySelector('[data-test-class=mac-window]').getAnimations().some(a=>a.playState==='running')"), "browser sheet motion settles");
  await waitBrowser(() => app.main<boolean>(`(async () => {
    const w=${app.win}, b=globalThis.browserAgentSubject, t=b?.tabs.get(b.activeId);
    if(!t?.attached || t.covered) return false;
    const r=await w.webContents.executeJavaScript("document.querySelector('[data-slot=native-view-frame]')?.getBoundingClientRect().toJSON()");
    const n=t.view.getBounds(); return r && ['x','y','width','height'].every(k=>Math.abs(r[k]-n[k])<=1);
  })()`), "native view follows the page card");
}

export async function shellGeometry(app: ShellApp, width: number, evidence: string) {
  const facts = await app.page.expression<{
    chat: number; sidebar: boolean; corners: string[]; title: { width: number; height: number }; dragWidth: number; draggable: number;
  }>(`(() => {
    const rect=n=>n.getBoundingClientRect(), header=document.querySelector('[data-test-class="custom-titlebar"]');
    const controls=document.querySelector('[data-test-class="project-controls"]');
    const sheet=document.querySelector('${pane}'), root=document.querySelector('[data-test-class="mac-window"]');
    return {chat:rect(document.querySelector('[data-slot="adaptive-shell-split-chat"]')).width,
      sidebar:root.getAttribute('data-left-open')==='true', corners:[getComputedStyle(sheet).borderTopLeftRadius,getComputedStyle(sheet).borderTopRightRadius],
      title:rect(header).toJSON(),dragWidth:rect(header).width-rect(controls).width,
      controls:[...controls.children].map(n=>({html:n.outerHTML,rect:rect(n).toJSON()})),
      pane:{html:sheet.outerHTML,background:getComputedStyle(sheet).backgroundColor,token:getComputedStyle(sheet).getPropertyValue('--browser-pane-bg')},
      draggable:header.querySelectorAll('[draggable="true"]').length};
  })()`);
  writeFileSync(join(evidence, "geometry-latest.json"), JSON.stringify(facts, null, 2));
  assert.equal(facts.chat, 400);
  assert.deepEqual(facts.corners, ["12px", "12px"]);
  assert.equal(facts.sidebar, width === 1440);
  assert.ok(facts.title.height >= 48);
  assert.equal(facts.draggable, 0);
  if (width === 1440) assert.ok(facts.dragWidth >= 1028, `drag width ${facts.dragWidth}`);
  return facts;
}
