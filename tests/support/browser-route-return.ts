/** A conversation's native page survives leaving the conversation (another session, Settings) and coming back. */
import { strict as assert } from "node:assert";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { waitBrowser } from "./browser-agent-app";
import { nativeAligned, pane, type ShellApp } from "./browser-shell-acceptance";

const FAVICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwAEhgHUZK2CdwAAAABJRU5ErkJggg==", "base64");

/** A page whose own frame is still while a video plays in it, like a watch page: its compositor frame only changes in the video layer. */
export function playingVideoFixture() {
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new URL(request.url).pathname === "/icon.png"
    ? new Response(FAVICON, { headers: { "content-type": "image/png" } })
    : new Response(`<!doctype html><title>Video fixture</title><link rel="icon" href="/icon.png">
<style>html,body{margin:0;height:100%;background:#365bf5}video{position:absolute;right:16px;bottom:16px;width:160px;height:120px}</style>
<video autoplay muted playsinline></video><script>
const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 120; const paint = canvas.getContext("2d"); let frame = 0;
setInterval(() => { paint.fillStyle = "hsl(" + (frame++ * 9 % 360) + ",70%,50%)"; paint.fillRect(0, 0, 160, 120); }, 33);
document.querySelector("video").srcObject = canvas.captureStream(30);
</script>`, { headers: { "content-type": "text/html" } }) });
}

async function pageShown(app: ShellApp, id: string, icon: string, label: string) {
  // The user looks at the window: an occluded test window pauses the renderer's frames, and with them its occlusion tracking.
  await app.main(`(()=>{const w=${app.win};w.show();w.focus();w.moveTop();w.webContents.focus()})()`);
  await nativeAligned(app);
  const facts = await app.main<{ bounds: { width: number; height: number }; favicon: string; capture: string }>(`(async () => {
    const b=globalThis.browserAgentSubject, t=b.tabs.get(${JSON.stringify(id)});
    // A still capture must settle while the page shows; a hung one never resolves.
    const capture=await Promise.race([b.capture(t).then(()=> "settled"), new Promise(done=>setTimeout(()=>done("hung"),10000))]);
    return { bounds: t.view.getBounds(), favicon: t.favicon, capture };
  })()`, 30_000);
  assert.ok(facts.bounds.width > 0 && facts.bounds.height > 0, `${label}: the page has its size`);
  await waitBrowser(() => app.main<boolean>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents.executeJavaScript("document.visibilityState === 'visible'")`), `${label}: the page is visible`);
  assert.equal(facts.capture, "settled", `${label}: a still of the page settles`);
  assert.equal(facts.favicon, icon, `${label}: the tab keeps its favicon`);
  assert.equal(await app.page.expression(`document.querySelector('${pane} [role=tab][aria-selected=true] img')?.getAttribute('src') ?? null`), icon, `${label}: the tab strip shows the favicon`);
  // The still capture never takes the page out of the window.
  await nativeAligned(app);
}

/** Five session round trips, five Settings round trips, then a reload: the page shows each time. */
export async function routeReturnKeepsPage(app: ShellApp, id: string, icon: string, otherSession: string) {
  const copy = getAppCopy("en-US");
  const back = () => waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${pane}'))`), "browser pane is back");
  for (let round = 0; round < 5; round++) {
    await app.click(otherSession);
    await waitBrowser(() => app.page.expression(`document.querySelector('[data-test-class=custom-titlebar]')?.textContent.includes(${JSON.stringify(otherSession)})`), "other session shown");
    await app.click(copy.space.general); await back();
    await pageShown(app, id, icon, `session round trip ${round + 1}`);
  }
  for (let round = 0; round < 5; round++) {
    await app.click(copy.sidebar.settings);
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=settings-page]'))"), "Settings shown");
    await app.click(copy.settings.back); await back();
    await pageShown(app, id, icon, `Settings round trip ${round + 1}`);
  }
  // The media stops while the user is away (a media key, headphones, the video ending): the page throttles again.
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents`;
  await app.click(copy.sidebar.settings);
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=settings-page]'))"), "Settings shown");
  await app.main(`${contents}.executeJavaScript("document.querySelector('video').pause()")`);
  await waitBrowser(() => app.main(`${contents}.getBackgroundThrottling() === true`), "paused page throttles again");
  await app.click(copy.settings.back); await back();
  await pageShown(app, id, icon, "media paused while away");
  await app.call("reload", { id });
  await waitBrowser(async () => (await app.call<{ tabs: Array<{ id: string; status: string; favicon: string }> }>("state")).tabs.some((tab) => tab.id === id && tab.status === "idle" && tab.favicon === icon), "reloaded page idle with its favicon");
  await pageShown(app, id, icon, "after reload");
}
