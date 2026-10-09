/** App-shell evidence through the real renderer and native window compositor. */
import { strict as assert } from "node:assert";
import { waitBrowser } from "./browser-agent-app";
import { nativeAligned, shellReady, togglePane, type ShellApp } from "./browser-shell-acceptance";

const root = '[data-test-class="mac-window"]';
const right = '[data-test-class="titlebar-right-panel-toggle"]';
export async function settled(app: ShellApp) {
  await waitBrowser(() => app.page.expression(`!document.querySelector('${root}')?.hasAttribute('data-track-switching') &&
    document.getAnimations().every(a=>a.effect?.getTiming().iterations===Infinity || a.playState!=='running')`), "shell motion settled");
  await app.page.expression("document.fonts.ready.then(()=>true)");
}
export async function setSidebar(app: ShellApp, open: boolean) {
  await settled(app);
  if (await app.page.expression(`document.querySelector('${root}').getAttribute('data-left-open')!==${JSON.stringify(String(open))}`)) {
    await app.page.clickSelector('[data-test-class="chrome-floating-toggle-layer"] button');
  }
  await waitBrowser(() => app.page.expression(`document.querySelector('${root}').getAttribute('data-left-open')===${JSON.stringify(String(open))}`), "sidebar state");
  await settled(app);
}
export async function titleIcons(app: ShellApp) {
  return app.page.expression<Record<string, number>>(`Object.fromEntries([...document.querySelectorAll('[data-test-class="project-controls"] button')]
    .map(n=>[n.getAttribute('data-test-class') || 'menu', n.getBoundingClientRect().x]))`);
}
export async function inspectorEvidence(app: ShellApp, name: string) {
  const closed = await titleIcons(app);
  const icon = await app.page.expression(`document.querySelector('${right} svg').outerHTML`);
  await app.page.expression(`(() => {
    window.shellIconFrames=[]; window.shellIconSampling=true;
    const sample=()=>{if(!window.shellIconSampling)return;window.shellIconFrames.push(Object.fromEntries(
      [...document.querySelectorAll('[data-test-class="project-controls"] button')].map(n=>[n.getAttribute('data-test-class') || 'menu',n.getBoundingClientRect().x])));requestAnimationFrame(sample)};sample();
  })()`);
  await app.page.clickSelector(right); await settled(app);
  const open = await titleIcons(app);
  await app.shot(`${name}-inspector-open`);
  const geometry = await cardGeometry(app);
  const active = await app.page.expression(`({pressed:document.querySelector('${right}').getAttribute('aria-pressed'),tone:document.querySelector('${right}').getAttribute('data-tone'),icon:document.querySelector('${right} svg').outerHTML})`);
  await app.page.clickSelector(right); await settled(app);
  await app.page.expression("window.shellIconSampling=false");
  const frames = await app.page.expression<Array<Record<string, number>>>("window.shellIconFrames");
  return { geometry, closed, open, closedAgain: await titleIcons(app), frames, icon, active };
}
export async function prepareCardsCell(app: ShellApp, theme: string, width: number) {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
    wallpaper: { source: { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
  await app.main(`${app.win}.setContentSize(${width},900)`);
  await app.page.reload(); await shellReady(app, "ko");
  await setSidebar(app, true);
  await settled(app); await app.click("일반"); await settled(app);
  if (await app.page.expression(`document.querySelector('${right}').getAttribute('aria-pressed')==='true' || document.querySelector('${root}').getAttribute('data-right-open')==='true'`)) {
    await app.page.clickSelector(right); await settled(app);
  }
}
export async function captureCardsCell(app: ShellApp, theme: string, width: number) {
  await prepareCardsCell(app, theme, width);
  const name = `ko-${theme}-${width}`;
  await app.shot(`${name}-conversation`);
  const conversation = await cardGeometry(app);
  const inspector = await inspectorEvidence(app, name);
  await togglePane(app, true); await nativeAligned(app);
  await app.shot(`${name}-conversation-browser`);
  const split = await cardGeometry(app);
  await togglePane(app, false); await settled(app);
  await setSidebar(app, false);
  await app.shot(`${name}-collapsed`);
  await app.page.movePointer(2, 400);
  await waitBrowser(() => app.page.expression(`document.querySelector('${root}').getAttribute('data-left-peek')==='true'`), "sidebar peek");
  await app.page.movePointer(100, 400); await settled(app);
  await app.shot(`${name}-peek`, true);
  const peek = await app.page.expression("getComputedStyle(document.querySelector('[data-slot=adaptive-shell-sidebar]')).opacity");
  await app.page.press("Escape"); await setSidebar(app, true);
  await app.click("브라우저"); await nativeAligned(app);
  await app.shot(`${name}-hub`);
  const hub = await cardGeometry(app);
  await app.click("새 대화");
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ wallpaper: {
    source: { kind: "live", module: "butler.shoreline", params: { realtime: false } }, motion: "paused", pauseOnBattery: false } }) });
  await waitBrowser(() => app.page.expression("document.querySelector('[data-module=\"butler.shoreline\"]')?.getAttribute('data-wallpaper-state')==='painted'"), "wallpaper painted");
  await settled(app); await app.shot(`${name}-wallpaper`);
  const wallpaper = await cardGeometry(app);
  await app.click("설정"); await settled(app); await app.shot(`${name}-settings`);
  const settings = await cardGeometry(app);
  await app.page.clickSelector('[data-test-class~="settings-titlebar"] [role="button"]'); await settled(app);
  return { theme, width, conversation, inspector, split, hub, peek, wallpaper, settings };
}
export async function cardGeometry(app: ShellApp) {
  return app.page.expression<{
    frame: string; layout: string; cards: Array<{ slot: string; radius: string; shadow: string; rect: { x: number; y: number; right: number; bottom: number } }>;
    wallpapersContained: boolean; title: { x: number; y: number; bottom: number } | null;
  }>(`(() => {
    const r=document.querySelector('${root}'),title=document.querySelector('[data-test-class=custom-titlebar]');
    const slots=['adaptive-shell-card','adaptive-shell-split-chat','browser-pane','inspector-shell','settings-detail'];
    return {frame:r.getAttribute('data-frame'),layout:r.getAttribute('data-panel-layout'),title:title?.getBoundingClientRect().toJSON()??null,
      cards:[...document.querySelectorAll(slots.map(s=>'[data-slot="'+s+'"]').join(',')+',.settings-detail')].filter(n=>n.getBoundingClientRect().width>0).map(n=>({slot:n.getAttribute('data-slot') || 'settings-detail',radius:getComputedStyle(n).borderRadius,shadow:getComputedStyle(n).boxShadow,rect:n.getBoundingClientRect().toJSON()})),
      wallpapersContained:[...document.querySelectorAll('[data-test-class~="wallpaper"]')].filter(n=>getComputedStyle(n).visibility!=='hidden').every(n=>Boolean(n.closest('[data-slot=adaptive-shell-card],[data-slot=adaptive-shell-split-chat]')))};
  })()`);
}
export function assertCardsCell(cell: Awaited<ReturnType<typeof captureCardsCell>>) {
  const { inspector } = cell;
  assert.deepEqual(inspector.open, inspector.closed, "opening inspector keeps every title icon fixed");
  assert.deepEqual(inspector.closedAgain, inspector.closed);
  for (const frame of inspector.frames) assert.deepEqual(frame, inspector.closed, "title icons stay fixed during motion");
  assert.deepEqual(inspector.active, { pressed: "true", tone: "butler", icon: inspector.icon });
  assert.equal(cell.peek, "1");
  for (const screen of [cell.conversation, cell.inspector.geometry, cell.split, cell.hub, cell.wallpaper, cell.settings]) {
    assert.equal(screen.frame, "cards"); assert.equal(screen.layout, "docked");
    assert.ok(screen.wallpapersContained, "wallpaper stays inside a content card");
    assert.ok(screen.cards.length>0);
    for (const card of screen.cards) {
      assert.equal(card.radius, "12px"); assert.equal(card.shadow, "none");
      assert.ok(card.rect.bottom<=892 && card.rect.right<=cell.width-8, "card retains window inset");
    }
  }
}
