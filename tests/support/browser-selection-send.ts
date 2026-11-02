/** Real selection chips → composer send → provider image and persisted message tiles. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { waitBrowser } from "./browser-agent-app";
import type { redesignApp } from "./browser-redesign-app";
import { shellReady } from "./browser-shell-acceptance";

type App = Awaited<ReturnType<typeof redesignApp>>;
const CHIPS = '[data-slot="element-chip"]';
const SENT = 'article [data-test-class="message-attachment-list"]';
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
export async function sendBrowserCaptures(app: App, tab: string, evidence: string, capture = app.shot) {
  const results = [];
  for (const theme of ["light", "dark"]) {
    await app.settings("en", theme, 1440);
    await app.click(getAppCopy("en-US").space.general);
    // First capture uses the real drag already performed by the caller; the second uses Attach selection.
    if (theme === "dark") await app.call("selection-command", { id: tab, op: "attach" });
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${CHIPS}').length===2`), "capture chips ready");
    await waitBrowser(() => app.page.expression(`Array.from(document.querySelectorAll('${CHIPS} img')).every(i=>i.complete&&i.naturalWidth>0)`), "capture chip thumbnails decoded");
    if (!baseline) await addPhoto(app);
    const phase = baseline ? "before" : "after";
    await capture(`${phase}-${theme}-composer`);
    const requests = app.visionRequests!;
    const before = requests.length;
    const prior = await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general");
    await app.page.clickSelector('[contenteditable="true"]');
    await app.page.insertText(`Describe selected content ${theme}`);
    await app.click("Send");
    await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general")).latest_turn?.id !== prior.latest_turn?.id, "capture turn admitted");
    await app.delivered();
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${CHIPS}').length===0`), "submitted chips cleared");
    const view = await app.gateway.api<any>("/session-view?session_id=general");
    const user = [...view.messages].reverse().find((m: any) => m.role === "user");
    assert.equal(user.attachments.length, baseline ? 2 : 3);
    assert.ok(user.attachments.every((f: any) => f.kind === (baseline ? "text" : "image")));
    const request = requests.slice(before).find(r => Array.isArray(r.body.tools) && JSON.stringify(r.messages).includes(`Describe selected content ${theme}`));
    assert.ok(request, "the send reaches the provider");
    assert.equal(JSON.stringify(request.body).includes('"type":"input_image"'), !baseline);
    if (!baseline) assert.ok(JSON.stringify(request.body).includes("untrusted_web_page_data"));
    const expected = baseline ? "file" : "image";
    await waitBrowser(() => app.page.expression(`(()=>{const lists=[...document.querySelectorAll('${SENT}')];const list=lists.at(-1);const tiles=[...(list?.querySelectorAll('[data-slot="attachment-tile"]')??[])];return tiles.length===${baseline ? 2 : 3}&&tiles.every(t=>t.dataset.kind==='${expected}'${baseline ? "" : "&&t.querySelector('img')?.naturalWidth>0"})})()`), "sent capture tiles");
    if (!baseline) await assertFits(app);
    await capture(`${phase}-${theme}-sent`);
    await app.page.reload(); await shellReady(app, "en");
    if (!baseline) await assertFits(app);
    results.push({ theme, storedKinds: user.attachments.map((f: any) => f.kind), providerImage: !baseline });
  }
  if (!baseline) await assertTextOnlyRefusal(app, tab, capture);
  writeFileSync(join(evidence, "selection-send-result.json"), JSON.stringify({ baseline, results }, null, 2));
}

async function addPhoto(app: App) {
  // Same name as browser captures: origin, rather than a name, decides fit.
  await app.page.expression(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=480;canvas.height=320;
    const c=canvas.getContext('2d'),gradient=c.createLinearGradient(0,0,480,320);
    gradient.addColorStop(0,'#8cc9ed');gradient.addColorStop(1,'#30816d');
    c.fillStyle=gradient;c.fillRect(0,0,480,320);c.fillStyle='#ffcf7a';c.beginPath();c.arc(360,80,40,0,Math.PI*2);c.fill();
    const blob=await new Promise(done=>canvas.toBlob(done,'image/jpeg')),bytes=await blob.arrayBuffer(),transfer=new DataTransfer();
    transfer.items.add(new File([bytes],'element.jpg',{type:'image/jpeg'}));
    const input=document.querySelector("input[type=file]");input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-test-class=composer-card] [data-slot=attachment-tile] img').length===1"), "ordinary photo uploaded");
}
async function assertFits(app: App) {
  const fits = await app.page.expression<string[]>(`(()=>{const list=[...document.querySelectorAll('${SENT}')].at(-1);
    return [...list.querySelectorAll('[data-slot=attachment-tile] img')].map(img=>getComputedStyle(img).objectFit)})()`);
  assert.deepEqual(fits, ["cover", "contain", "contain"], "uploaded photo covers; browser captures contain, including after reload");
}

async function assertTextOnlyRefusal(app: App, tab: string, capture: typeof app.shot) {
  const registered = await app.gateway.api<any>("/model-catalog/local-models", { method: "POST", body: JSON.stringify({
    provider_id: "local", api_type: "openai_compatible", platform: "custom", server_url: app.gateway.url,
    model_id: "text-only", display_name: "Text only", context_window_tokens: 128000, source: "manual", image_input: false,
  }) });
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ model: registered.model.model_ref }) });
  await app.page.reload(); await shellReady(app, "en");
  await app.call("selection-command", { id: tab, op: "attach" });
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-test-class=composer-card] [data-blocked=true]').length===2"), "text-only model marks both images blocked");
  assert.equal(await app.page.expression("document.querySelector('[data-test-class=composer-card] button[aria-label=Send]')?.getAttribute('aria-disabled')"), "true");
  await capture("after-dark-text-only-refusal");
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ model: "openai/gpt-6-luna" }) });
  await app.page.reload(); await shellReady(app, "en");
}
