import { strict as assert } from "node:assert";
import { waitBrowser, type browserAgentApp } from "./browser-agent-app";

type App = Awaited<ReturnType<typeof browserAgentApp>>;
export async function showPickSidebar(app: App) {
  const visible = "(()=>{const r=document.querySelector('[data-test-class=mac-window]');return r.dataset.leftOpen==='true'||r.dataset.leftPeek==='true'})()";
  if (!await app.page.expression(visible)) {
    await app.click(await app.page.expression("document.documentElement.lang.startsWith('ko')?'사이드바 보기':'Show sidebar'"));
  }
  await waitBrowser(() => app.page.expression(visible), "sidebar open or peeked for drop");
}
export const overlayRead = <T>(app: App, expression: string) => app.main<T>(
  `globalThis.browserAgentSubject.pointer.view.webContents.executeJavaScript(${JSON.stringify(expression)})`,
);
export async function hoverPick(app: App, tab: string, selector: string) {
  const point = await app.main<{ x: number; y: number; width: number; height: number; scale: number }>(`(async()=>{
    const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)});
    const r=await t.view.webContents.executeJavaScript(${JSON.stringify(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)});
    return {...r,scale:t.bounds.scale ?? 1};})()`);
  await app.main(`globalThis.browserAgentSubject.pointer.view.webContents.sendInputEvent({type:'mouseMove',x:${Math.round((point.x + 24) * point.scale)},y:${Math.round((point.y + point.height / 2) * point.scale)}})`);
  await waitBrowser(() => overlayRead(app, "Boolean(document.querySelector('[data-pick-outline=hover]'))"), "hover outline painted");
  const width = await overlayRead<number>(app, "document.querySelector('[data-pick-outline=hover]').getBoundingClientRect().width");
  assert.ok(Math.abs(width - point.width * point.scale) < 1, "hover uses CSS px × scale");
  assert.match(await overlayRead<string>(app, "document.querySelector('[data-pick-outline=hover]').textContent"), /h1 · \d+ × \d+/);
}
export async function emptyPick(app: App) {
  await waitBrowser(() => overlayRead(app, "Boolean(document.querySelector('[data-slot=selection-bar]'))"), "bar before first pick");
  assert.equal(await overlayRead(app, "[...document.querySelectorAll('[data-slot=selection-bar] button[aria-disabled=true]')].filter(n=>n.getBoundingClientRect().width>0).length"), 2);
  assert.equal(await overlayRead(app, "document.querySelectorAll('[data-pick-badge]').length"), 0);
}
export async function pickBadges(app: App, count: number) {
  await waitBrowser(() => overlayRead(app, `document.querySelectorAll('[data-pick-badge]').length===${count}`), "ordered pick badges");
  assert.deepEqual(await overlayRead(app, "[...document.querySelectorAll('[data-pick-badge]')].map(n=>n.textContent)"), Array.from({ length: count }, (_, i) => String(i + 1)));
}
export async function dragPreview(app: App, invalid: boolean) {
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('[data-slot=drag-preview-floating]')) &&
    (document.querySelector('[data-slot=drag-preview]').dataset.invalid==='true')===${invalid}`), "floating preview reflects the drop target");
  assert.equal(await app.page.expression("document.querySelector('[data-slot=drag-preview]').dataset.invalid==='true'"), invalid);
  assert.equal(await app.page.expression("document.querySelectorAll('[data-slot=drag-preview] img').length"), 2);
  assert.equal(await app.page.expression("getComputedStyle(document.querySelector('[data-slot=drag-preview-floating]')).position"), "fixed");
}
