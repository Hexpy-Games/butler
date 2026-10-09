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
  await waitBrowser(() => app.page.expression(`(() => {
    const button=document.querySelector('${toggle}'), workspace=document.querySelector('[data-slot=adaptive-shell-workspace]');
    if (!button || workspace?.getAnimations().some(a=>a.playState==='running')) return false;
    const r=button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  })()`), "browser toggle is hit-testable after shell motion");
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
  await waitBrowser(() => app.page.expression("!document.querySelector('[data-test-class=mac-window]').hasAttribute('data-track-switching') && !document.querySelector('[data-slot=adaptive-shell-workspace]').getAnimations().some(a=>a.playState==='running') && !document.querySelector('[data-slot=browser-pane]').getAnimations({subtree:true}).some(a=>a.playState==='running') && !document.querySelector('[data-test-class=mac-window]').getAnimations().some(a=>a.playState==='running')"), "browser sheet motion settles");
  await waitBrowser(() => app.main<boolean>(`(async () => {
    const w=${app.win}, b=globalThis.browserAgentSubject, t=b?.tabs.get(b.activeId);
    if(!t?.attached || t.covered) return false;
    const r=await w.webContents.executeJavaScript("document.querySelector('[data-slot=native-view-frame]')?.getBoundingClientRect().toJSON()");
    const n=t.view.getBounds(); return r && ['x','y','width','height'].every(k=>Math.abs(r[k]-n[k])<=1);
  })()`), "native view follows the page card");
}

export async function shellGeometry(app: ShellApp, width: number, evidence: string) {
  const facts = await app.page.expression<{
    toolbarUncovered: boolean; chatContainsPaint: string; chat: number; sidebar: boolean; corners: string[]; title: { width: number; height: number }; dragWidth: number; draggable: number;
  }>(`(() => {
    const rect=n=>n.getBoundingClientRect(), header=document.querySelector('[data-test-class="custom-titlebar"]');
    const controls=document.querySelector('[data-test-class="project-controls"]');
    const sheet=document.querySelector('${pane}'), root=document.querySelector('[data-test-class="mac-window"]');
    return {chat:rect(document.querySelector('[data-slot="adaptive-shell-split-chat"]')).width,
      sidebar:root.getAttribute('data-left-open')==='true', corners:[getComputedStyle(sheet).borderTopLeftRadius,getComputedStyle(sheet).borderTopRightRadius],
      toolbarHits:[...sheet.querySelectorAll('[data-slot=browser-toolbar] button,[data-slot=browser-toolbar] input')].map(n=>{
        const r=rect(n), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {label:n.getAttribute('aria-label'),rect:r.toJSON(),hit:hit?.outerHTML.slice(0,300)};
      }),
      toolbarUncovered:[...sheet.querySelectorAll('[data-slot=browser-toolbar] button,[data-slot=browser-toolbar] input')].filter(n=>n.getBoundingClientRect().width>0).every(n=>{
        const r=rect(n), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return Boolean(hit?.closest('[data-slot=browser-toolbar]'));
      }),
      chatContainsPaint:getComputedStyle(document.querySelector('[data-slot="adaptive-shell-split-chat"]')).contain,
      title:rect(header).toJSON(),dragWidth:rect(header).width-rect(controls).width,
      controls:[...controls.children].map(n=>({html:n.outerHTML,rect:rect(n).toJSON()})),
      pane:{html:sheet.outerHTML,background:getComputedStyle(sheet).backgroundColor,token:getComputedStyle(sheet).getPropertyValue('--browser-pane-bg')},
      draggable:header.querySelectorAll('[draggable="true"]').length};
  })()`);
  writeFileSync(join(evidence, "geometry-latest.json"), JSON.stringify(facts, null, 2));
  assert.equal(facts.toolbarUncovered, true, "chat layers never cover browser toolbar controls");
  assert.ok(facts.chatContainsPaint.includes("paint"));
  assert.equal(facts.chat, 400);
  assert.deepEqual(facts.corners, ["12px", "12px"]);
  assert.equal(facts.sidebar, width === 1440);
  assert.ok(facts.title.height >= 48);
  assert.equal(facts.draggable, 0);
  if (width === 1440) assert.ok(facts.dragWidth >= 1028, `drag width ${facts.dragWidth}`);
  return facts;
}

/** Native input must dismiss a peek even when the renderer receives no pointerleave. */
export async function nativePeekDismiss(app: ShellApp, name: string, evidence: string) {
  await app.page.movePointer(2, 400);
  const open = "document.querySelector('[data-left-peek=\"true\"]') !== null";
  await waitBrowser(() => app.page.expression<boolean>(open), "left-edge sidebar peek");
  await app.page.movePointer(100, 400);
  await app.shot(`${name}-peek-open`, true);
  assert.equal(await app.page.expression(open), true);
  const source = await app.main<string>(`${app.win}.getMediaSourceId()`);
  const capture = process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE; assert.ok(capture);
  const start = Date.now();
  // Native webContents input bypasses the renderer DOM and exercises main -> preload -> hook.
  await app.main(`(() => {
    const b=globalThis.browserAgentSubject, t=b.tabs.get(b.activeId);
    if (t.attached !== ${app.win}) throw new Error('native page must be attached');
    t.view.webContents.sendInputEvent({type:'mouseMove',x:100,y:200});
  })()`);
  assert.equal(await app.page.expression(open), true, "peek retains its dismiss delay");
  const closing = Bun.spawnSync([capture, source.split(":")[1]!, join(evidence, `${name}-peek-closing.png`)]);
  assert.equal(closing.exitCode, 0, closing.stderr.toString());
  writeFileSync(join(evidence, `${name}-peek-closing-renderer.png`), await app.page.screenshot());
  await waitBrowser(async () => !await app.page.expression<boolean>(open), "native pointer dismisses peek");
  const elapsedMs = Date.now() - start;
  await app.shot(`${name}-peek-closed`, true);
  return { elapsedMs };
}
