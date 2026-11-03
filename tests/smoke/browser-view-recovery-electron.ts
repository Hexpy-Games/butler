// test-category: race
/** Real renderer loss, background cover transitions and long-loading history. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady, togglePane } from "../support/browser-shell-acceptance";
import { getAppCopy } from "../../packages/butler-i18n/src/index";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const html = `<!doctype html><title>Recovery fixture</title><style>
html,body{margin:0;height:100%;background:#365bf5}button{width:100%;height:100%;background:transparent;color:white;border:0}
</style><button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Live page</button>
<video muted autoplay></video><script>
const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
const paint=()=>{canvas.getContext('2d').fillRect(0,0,64,64);requestAnimationFrame(paint)};paint();
document.querySelector('video').srcObject=canvas.captureStream(10);
</script>`;
const fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
  if (new URL(request.url).pathname === "/hold") return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("waiting"));
  } }));
  return new Response(html + (new URL(request.url).pathname === "/loading" ? '<img src="/hold">' : ""), { headers: { "content-type": "text/html" } });
} });
const app = await browserAgentApp(evidence, () => null);
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
  await app.page.reload(); await shellReady(app, "en");
  await app.call("open");
  const id = await app.call<string>("create", { url: fixture.url.href });
  await app.click("Browser"); await app.call("activate", { id });
  const tab = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})`;
  await waitBrowser(() => app.main(`${tab}.status==='idle' && ${tab}.view.webContents.getTitle()==='Recovery fixture'`), "fixture loaded");
  await nativeAligned(app);
  if (process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE) await app.shot("browser");
  writeFileSync(join(evidence, "browser-renderer.png"), await app.page.screenshot());
  await app.main(`(async()=>{const image=await ${tab}.view.webContents.capturePage();process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(join(evidence, "browser-native.png"))},image.toPNG())})()`);
  const facts: Record<string, unknown> = {};
  // A pending subresource plus same-document navigation must not queue one Electron
  // load-completion listener per history metadata read.
  facts.listeners = await app.main(`(async()=>{
    const t=${tab},c=t.view.webContents,baseline=c.listenerCount('did-stop-loading');
    void c.loadURL(${JSON.stringify(new URL("loading", fixture.url).href)}).catch(()=>{});
    await new Promise(r=>setTimeout(r,100));
    const loadingBaseline=c.listenerCount('did-stop-loading');
    for(let i=0;i<24;i++) {
      await c.mainFrame.executeJavaScript('history.pushState({},"","#'+i+'")');
      await new Promise(r=>setTimeout(r,10));
    }
    const loading=c.isLoadingMainFrame(),during=c.listenerCount('did-stop-loading');c.stop();
    await new Promise(r=>setTimeout(r,100));
    return {baseline,loadingBaseline,loading,during,after:c.listenerCount('did-stop-loading')};
  })()`);
  writeFileSync(join(evidence, "recovery.json"), JSON.stringify(facts, null, 2));
  const listeners = facts.listeners as { baseline: number; loadingBaseline: number; during: number; after: number };
  assert.equal(listeners.during, listeners.loadingBaseline, "history does not accumulate load-completion listeners");
  assert.equal(listeners.after, listeners.baseline);
  await app.call("navigate", { id, value: fixture.url.href });
  await waitBrowser(() => app.main(`${tab}.status==='idle'`), "leave long-loading fixture");
  // Back acts at once on a page that is still loading, and stop stays on that page.
  const loading = JSON.stringify(new URL("loading", fixture.url).href);
  await app.call("navigate", { id, value: new URL("loading", fixture.url).href });
  await waitBrowser(() => app.main(`${tab}.view.webContents.getURL()===${loading} && ${tab}.view.webContents.isLoadingMainFrame()`), "long-loading page");
  await app.call("back", { id });
  await waitBrowser(() => app.main(`new URL(${tab}.view.webContents.getURL()).pathname==='/' && ${tab}.status==='idle'`), "back while loading");
  await app.call("forward", { id });
  await waitBrowser(() => app.main(`${tab}.view.webContents.getURL()===${loading} && ${tab}.view.webContents.isLoadingMainFrame()`), "forward to long-loading page");
  await app.call("stop", { id });
  await waitBrowser(() => app.main(`${tab}.view.webContents.getURL()===${loading} && !${tab}.view.webContents.isLoadingMainFrame() && ${tab}.status==='idle'`), "stop stays on the page");
  await app.call("navigate", { id, value: fixture.url.href });
  await waitBrowser(() => app.main(`${tab}.status==='idle'`), "leave long-loading page");
  // This is a real renderer crash, recovered using the existing public sad-tab action.
  await app.main(`${tab}.view.webContents.forcefullyCrashRenderer()`);
  await waitBrowser(() => app.main(`${tab}.status==='crashed'`), "gone renderer sad state");
  await app.call("reload", { id });
  await waitBrowser(() => app.main(`${tab}.status==='idle'`), "renderer reload");
  await nativeAligned(app);
  facts.crash = await app.main(`${tab}.view.webContents.mainFrame.executeJavaScript('document.title')`);
  for (const sequence of ["background-cover", "minimize", "hide", "move", "detached", "pane"]) {
    if (sequence === "pane") {
      if (process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE) await app.shot("pane");
      await app.call("move", { tabId: id, toGroupId: "conversation:general", index: 0 });
      await app.page.clickText(getAppCopy("en-US").space.general, '[data-test-class="app-sidebar"] button, [data-test-class="app-sidebar"] [role="button"]');
      await togglePane(app, true); await app.call("activate", { id });
    } else await app.main(`(async()=>{
      const b=globalThis.browserAgentSubject,t=${tab},w=${app.win};
      if(${JSON.stringify(sequence)}==='background-cover') {
        w.blur();b.commandTab('covered',t.id,true);w.setContentSize(1100,780);b.commandTab('covered',t.id,false);w.focus();
      }
      if(${JSON.stringify(sequence)}==='minimize'){w.minimize();await new Promise(r=>setTimeout(r,200));w.restore();w.focus()}
      if(${JSON.stringify(sequence)}==='hide'){w.hide();w.setContentSize(1200,820);w.show();w.focus()}
      if(${JSON.stringify(sequence)}==='move'){const [x,y]=w.getPosition();w.setPosition(x+20,y+20);w.setPosition(x,y)}
      if(${JSON.stringify(sequence)}==='detached'){w.contentView.removeChildView(t.view);w.hide();w.show();w.focus()}
    })()`);
    await nativeAligned(app);
    await waitBrowser(() => app.main(`${tab}.attached===${app.win} && ${tab}.view.getVisible() && !${tab}.covered`), `${sequence}: live attachment`);
    const nativeInput = process.env.BUTLER_BROWSER_NATIVE_INPUT_EXECUTABLE;
    if (nativeInput) {
      const point = await app.main<{ pid: number; x: number; y: number }>(`(()=>{
        const w=${app.win},b=${tab}.view.getBounds(),p=w.getContentBounds();w.show();w.focus();w.moveTop();
        return {pid:process.pid,x:p.x+b.x+30,y:p.y+b.y+30};
      })()`);
      const before = await app.main<number>(`${tab}.view.webContents.mainFrame.executeJavaScript("Number(document.querySelector('button').dataset.clicks||0)")`);
      const input = Bun.spawn([nativeInput, String(point.pid), "click", String(point.x), String(point.y)], { stdout: "pipe", stderr: "pipe" });
      assert.equal(await input.exited, 0, await new Response(input.stderr).text());
      await waitBrowser(() => app.main(`${tab}.view.webContents.mainFrame.executeJavaScript("Number(document.querySelector('button').dataset.clicks||0)").then(n=>n===${before + 1})`), `${sequence}: native hit test`);
    }
    facts[sequence] = await app.main(`(async()=>{
      const t=${tab},w=${app.win},c=t.view.webContents;
      if(t.attached!==w || !w.contentView.children.includes(t.view) || !t.view.getVisible() || t.covered)
        throw new Error('live view is not attached and visible');
      const before=await c.mainFrame.executeJavaScript("Number(document.querySelector('button').dataset.clicks||0)");
      c.sendInputEvent({type:'mouseDown',x:30,y:30,button:'left',clickCount:1});
      c.sendInputEvent({type:'mouseUp',x:30,y:30,button:'left',clickCount:1});
      await new Promise(r=>setTimeout(r,100));
      const after=await c.mainFrame.executeJavaScript("Number(document.querySelector('button').dataset.clicks||0)");
      if(after!==before+1) throw new Error('live renderer did not receive input');
      return {attached:true,visible:true,bounds:t.view.getBounds(),slot:t.slot,clicks:after};
    })()`);
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=native-view-slot] img'))"), false, "no still stands in for the live page");
    writeFileSync(join(evidence, "recovery.json"), JSON.stringify(facts, null, 2));
    if (sequence === "pane") {
      writeFileSync(join(evidence, "pane-renderer.png"), await app.page.screenshot());
      await app.main(`(async()=>{const image=await ${tab}.view.webContents.capturePage();process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(join(evidence, "pane-native.png"))},image.toPNG())})()`);
      await app.click("Browser");
      await app.call("activate", { id });
      await nativeAligned(app);
    }
  }
  facts.nativeInput = Boolean(process.env.BUTLER_BROWSER_NATIVE_INPUT_EXECUTABLE);
  // A busy page that answers again returns to its live view without a reload.
  await app.main(`globalThis.recoveryUnresponsive=false;${tab}.view.webContents.once('unresponsive',()=>{globalThis.recoveryUnresponsive=true});${tab}.view.webContents.mainFrame.executeJavaScript('setTimeout(()=>{const end=Date.now()+25000;while(Date.now()<end){}},0);true')`);
  await app.main(`${tab}.view.webContents.sendInputEvent({type:'keyDown',keyCode:'A'})`);
  await waitBrowser(() => app.main(`globalThis.recoveryUnresponsive && ${tab}.status==='crashed'`), "unresponsive renderer sad state");
  await waitBrowser(() => app.main(`${tab}.status==='idle' && !${tab}.failure && ${tab}.attached===${app.win} && ${tab}.view.getVisible()`), "responsive renderer live again");
  await nativeAligned(app);
  // A readback that settles late was slow, not wedged: the tab returns to its live view by itself.
  facts.slow = await app.main(`(async()=>{
    const b=globalThis.browserAgentSubject,t=${tab},c=t.view.webContents;
    await b.capture(t);const original=c.capturePage.bind(c),image=await original();let release;
    c.capturePage=()=>new Promise(done=>{release=()=>done(image)});
    const pending=b.capture(t);b.commandTab('covered',t.id,true);b.commandTab('covered',t.id,false);
    await pending;c.capturePage=original;const failed={status:t.status,failure:t.failure};
    release();return failed;
  })()`);
  assert.deepEqual(facts.slow, { status: "crashed", failure: "stalled" }, "a stalled readback shows the sad tab");
  await waitBrowser(() => app.main(`${tab}.status==='idle' && !${tab}.failure && ${tab}.attached===${app.win} && ${tab}.view.getVisible()`), "slow readback live again");
  await nativeAligned(app);
  // A wedged surface never settles a readback: the window's return probe finds it with no user action.
  await app.main(`(async()=>{const t=${tab},c=t.view.webContents,w=${app.win};w.hide();await new Promise(r=>setTimeout(r,500));globalThis.recoveryCapture=c.capturePage;c.capturePage=()=>new Promise(()=>{});w.show();w.focus();})()`);
  await waitBrowser(() => app.main(`${tab}.status==='crashed' && ${tab}.failure==='stalled'`), "wedged view found on return");
  await app.main(`(()=>{${tab}.view.webContents.capturePage=globalThis.recoveryCapture;})()`);
  await app.call("reload", { id });
  await waitBrowser(() => app.main(`${tab}.status==='idle' && !${tab}.detachWait && !${tab}.attachWait && !${tab}.placeHold`), "wedged view reload");
  await nativeAligned(app);
  writeFileSync(join(evidence, "recovery.json"), JSON.stringify(facts, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), expression: app.lastMain(),
    dom: await app.page.expression("({hidden:document.hidden,holds:[...document.querySelectorAll('[data-native-view-hold]')].map(n=>n.outerHTML.slice(0,1000)),animations:document.getAnimations().filter(a=>a.playState==='running').map(a=>({target:a.effect?.target?.outerHTML.slice(0,300),timing:a.effect?.getComputedTiming()})),body:document.body.innerText.slice(0,1500)})").catch(() => null),
    state: await app.main(`(()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(b.activeId);return {status:t?.status,covered:t?.covered,attached:t?.attached?.id,visible:t?.view?.getVisible(),captures:t?.captures?.size,detach:!!t?.detachWait,attach:!!t?.attachWait,place:!!t?.placeHold}})()`).catch(() => null) }, null, 2));
  throw error;
} finally { fixture.stop(true); await app.stop(); }
