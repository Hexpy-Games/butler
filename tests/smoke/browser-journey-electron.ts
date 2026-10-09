// test-category: race
/** One public conversation turn drives trusted native input and delivers a crop. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
import type { StubModelRequest } from "../support/native-app-server";
import { togglePane } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const stub = browserStub(), app = await browserAgentApp(evidence, stub.handler);
const fixture = `<!doctype html><meta charset="utf-8"><title>Browser journey</title>
<style>body{font:18px system-ui;padding:40px;background:#f4f5fa;color:#172033}main{background:white;padding:30px}button{padding:14px}input{width:300px}img{display:block;width:180px;height:120px}</style>
<main><h1>Browser journey</h1><button onclick="document.querySelector('#result').textContent='Confirmed'">Confirm</button>
<p id="result">Ready</p><label>Brightness <input type="range" aria-label="Brightness" value="20" oninput="document.querySelector('#value').textContent=this.value"></label><p id="value">20</p>
<img alt="Blue dress" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><rect width="180" height="120" fill="#365bf5"/><path d="M80 20h20l30 85H50z" fill="#fff"/></svg>')}"></main>`;

function observed(request: StubModelRequest, role: string, name: string) {
  const result = latestBrowser(request, "obs");
  const text = (result.untrusted_content as { text: string }).text;
  const ref = new RegExp(`${role} "${name}" \\[([^\\]]+)\\]`, "u").exec(text)?.[1];
  assert.ok(ref, text); return { tab: result.tab, observation: result.obs, ref };
}
async function send(text: string) {
  const prior = await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general");
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => {
    const view = await app.gateway.api<{ latest_turn?: { id: string; state: string } }>("/session-view?session_id=general");
    return view.latest_turn?.id !== prior.latest_turn?.id && view.latest_turn?.state === "delivered";
  }, "delivered user turn");
}
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  await app.call("open");
  stub.set([
    () => ({ name: "write_file", arguments: { path: "browser-journey/index.html", create_parents: true, content: fixture } }),
    () => ({ name: "output_publish", arguments: { path: "browser-journey", title: "Browser journey" } }),
  ]);
  await send("Publish the browser journey fixture");
  const artifacts = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const output = artifacts.artifacts.find(item => item.kind === "web"); assert.ok(output);
  const view = await app.gateway.api<{ url: string }>(`/outputs/${output.id}/view`);
  const names = ["browser_open", "browser_observe", "browser_act", "browser_selection", "browser_screenshot"];
  const observe = (request: StubModelRequest) => bridgeBrowser("browser_observe", { tab: latestBrowser(request, "tab").tab, look: "always" });
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: names.map(name => `native:${name}`) } }),
    () => bridgeBrowser("browser_open", { url: view.url }), observe,
    request => { const { ref, ...args } = observed(request, "button", "Confirm"); return bridgeBrowser("browser_act", { ...args, steps: [{ action: "click", ref }] }); },
    observe,
    request => { const { ref, ...args } = observed(request, "slider", "Brightness"); return bridgeBrowser("browser_act", { ...args, steps: [{ action: "drag", ref, offset: [100, 0] }] }); },
    observe,
    request => bridgeBrowser("browser_selection", { tab: latestBrowser(request, "tab").tab }),
    request => bridgeBrowser("browser_screenshot", observed(request, "image", "Blue dress")),
  ]);
  const started = performance.now(); await send("Open, observe, click Confirm by ref, drag Brightness, attach the Blue dress crop and finish.");
  const turnElapsedMs = performance.now() - started;
  assert.ok(!JSON.stringify(stub.results).includes('"stubFailure"'), JSON.stringify(stub.results));
  const snapshot = await app.call<{ tabs: Array<{ id: string; agent: boolean; inUse: boolean; busy: boolean }> }>("state");
  const tab = snapshot.tabs.find(item => item.agent); assert.ok(tab);
  assert.equal(tab.inUse, false); assert.equal(tab.busy, false);
  const native = await app.main<{ result: string; value: number; pointer: unknown }>(`(async()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)});return {...await t.view.webContents.executeJavaScript("({result:document.querySelector('#result').textContent,value:Number(document.querySelector('input').value)})"),pointer:t.pointer}})()`);
  assert.equal(native.result, "Confirmed"); assert.ok(native.value > 70, JSON.stringify(native)); assert.equal(native.pointer, null);
  const messages = await app.gateway.api<{ messages: Array<{ role: string; attachments?: Array<{ kind: string; mime_type: string; size_bytes: number }> }> }>("/messages?chat_id=general");
  const reply = messages.messages.filter(item => item.role === "assistant").at(-1)!;
  assert.ok(reply.attachments?.some(file => file.kind === "image" && file.mime_type === "image/jpeg" && file.size_bytes > 0), JSON.stringify(reply));
  // Exercise the same capture on a vision request; the local stub has no vision admission.
  const pixels = await app.main<{ imageBytes: number; width: number; refs: number }>(`(async()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)});const r=await globalThis.browserAgentSubject.execute({op:'tab.observe',session:'general',tab:t.id,args:{include_image:true,look:'always'}});return {imageBytes:Buffer.from(r.image.data,'base64').length,width:r.image?.width,refs:r.nodes.length}})()`);
  assert.ok(pixels.imageBytes > 0); assert.ok(pixels.width <= 1024);
  await app.call("activate", { id: tab.id });
  // The fixture's local output URL contains an access capability. Keep it out of captures.
  await app.main(`(()=>{const b=globalThis.browserAgentSubject;b.tabs.get(${JSON.stringify(tab.id)}).url='https://fixture.test/browser-journey';b.publish()})()`);
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
    await app.page.reload(); await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
    await app.main(`${app.win}.setContentSize(${width},900)`);
    await app.call("activate", { id: tab.id }); await app.click(language === "ko" ? "브라우저" : "Browser");
    await app.call("control", { id: tab.id, holder: "agent" });
    await waitBrowser(() => app.page.expression("!document.querySelector('[data-test-class=browser-agent-control]')"), "released tab presentation");
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-test-class=browser-agent-control]'))"), false);
    await app.shot(`${language}-${theme}-${width}-released`);
    await app.click(language === "ko" ? "일반" : "General");
    if (!await app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))")) await togglePane(app, true);
    await app.call("control", { id: tab.id, holder: "agent" });
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-test-class=browser-agent-control]'))"), false);
    await app.shot(`${language}-${theme}-${width}-docked-released`);
    await togglePane(app, false);
    await waitBrowser(() => app.page.expression("[...document.querySelectorAll('[data-test-class=message-artifact-list]')].some(a=>a.textContent.includes('.jpg'))"), "reply crop is visible in the App");
    await app.shot(`${language}-${theme}-${width}-reply`);
  }
  const secure = await app.main<{ masked: boolean; cropReason: string; scoped: string }>(`(async()=>{
    const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab.id)});
    await t.view.webContents.executeJavaScript("document.querySelector('main').insertAdjacentHTML('beforeend','<input autocomplete=one-time-code aria-label=Verification value=TEST_CAPTURE_ONLY>')");
    const args={op:'tab.observe',session:'general',tab:t.id,args:{include_image:true,look:'always'}};
    const r=await b.execute(args),node=r.nodes.find(n=>n.secure);
    const image=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron').nativeImage.createFromDataURL('data:image/jpeg;base64,'+r.image.data);
    const raw=await t.view.webContents.capturePage(),scale=(t.bounds?.scale??1)*image.getSize().width/raw.getSize().width;
    const x=Math.round((node.rect.x+node.rect.width/2)*scale),y=Math.round((node.rect.y+node.rect.height/2)*scale),pixels=image.getBitmap(),i=(y*image.getSize().width+x)*4;
    const crop=await b.execute({op:'tab.screenshot',session:'general',tab:t.id,args:{observation:r.obs,ref:node.ref}});
    await t.view.webContents.executeJavaScript("document.querySelector('main').insertAdjacentHTML('beforeend','<iframe src=about:blank></iframe>')");
    const scoped=await b.execute({...args,args:{...args.args,frame:'f0'}});
    return {masked:pixels[i]<20&&pixels[i+1]<20&&pixels[i+2]<20,cropReason:crop.reason,scoped:scoped.image_status};
  })()`);
  assert.equal(secure.masked, true); assert.equal(secure.cropReason, "secure_field");
  assert.equal(secure.scoped, "frame_scoped");
  writeFileSync(join(evidence, "journey.json"), JSON.stringify({ turnElapsedMs, elapsedMs: performance.now() - started, native, pixels, secure, reply, tabs: snapshot.tabs.map(item=>({...item,url:"[local fixture]"})), requestSchemas: app.gateway.stubModelCalls.filter(call => call.stream).map(call => call.body.tools) }, null, 2));
  console.log(JSON.stringify({ status: "passed", native, pixels, attachments: reply.attachments?.length }));
} finally { await app.stop(); }
