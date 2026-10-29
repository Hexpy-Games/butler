/** #1583: pane motion re-attaches a native tab while its still capture is in flight; every capture must still settle. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";

function captureFailureHandlingSource(variantExpression: string, evidenceFile: string): string {
  return [
    `const variant=${variantExpression},failureFile=${JSON.stringify(evidenceFile)};`,
    "let round=0;",
    "const read=value=>{try{return value()}catch(error){return {error:String(error)}}};",
    "const failureSnapshot=async(label)=>{",
    "  const attached=t?.attached,view=t?.view,contents=view?.webContents;",
    "  const captures=read(()=>[...(t?.captures?.entries?.()??[])].map(([,startedHidden])=>({startedHidden})));",
    "  const documentVisibilityState=contents?await contents.executeJavaScriptInIsolatedWorld(9001,[{code:'document.visibilityState'}])",
    "    .catch(error=>'unavailable: '+String(error)):null;",
    "  return {variant,round,label,",
    "    attachedWindowId:attached?read(()=>attached.id??attached.getId()):null,",
    "    attachedWindowVisible:attached?read(()=>attached.isVisible()):null,",
    "    attachedWindowFocused:attached?read(()=>attached.isFocused()):null,",
    "    viewVisible:view?read(()=>view.getVisible()):null,",
    "    viewBounds:view?read(()=>view.getBounds()):null,slotBounds:t?.slot??null,",
    "    detachWait:Boolean(t?.detachWait),attachWait:Boolean(t?.attachWait),placeHold:Boolean(t?.placeHold),",
    "    inFlightCaptures:{count:Array.isArray(captures)?captures.length:null,startedHidden:captures},",
    "    webContentsBeingCaptured:contents?read(()=>contents.isBeingCaptured()):null,documentVisibilityState};",
    "};",
    "const settles=async(label,promise)=>{let timer;const hung=new Promise((_,fail)=>{timer=setTimeout(async()=>{",
    "  let snapshot;try{snapshot=await failureSnapshot(label)}catch(error){snapshot={variant,round,label,diagnosticError:String(error)}}",
    "  const failure=new Error(label+' never settled; snapshot='+JSON.stringify(snapshot));",
    "  try{process.getBuiltinModule('fs').writeFileSync(failureFile,JSON.stringify(snapshot,null,2))}",
    "  catch(error){failure.message+='; evidence write failed: '+String(error)}",
    "  fail(failure);",
    "},10000)});",
    "try{return await Promise.race([promise,hung])}finally{clearTimeout(timer)}};",
  ].join("\n");
}

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const failureFile = join(evidence, "capture-detach-failure.json");
const fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(
  "<!doctype html><title>Capture fixture</title><style>html,body{margin:0;height:100%;background:#365bf5}</style>",
  { headers: { "content-type": "text/html" } }) });
const app = await browserAgentApp(evidence, () => null);
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
  await app.page.reload(); await shellReady(app, "en");
  await app.call("open");
  const id = await app.call<string>("create", { url: fixture.url.href });
  await app.click("Browser"); await app.call("activate", { id });
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), "browser pane");
  await nativeAligned(app);
  const facts: Record<string, unknown> = {};
  // A capture may start in a visible window even when throttling is off. It must
  // finish in that window before the view moves to the hidden agent window, or back.
  for (const throttling of [false, true]) {
    const diagnostics = captureFailureHandlingSource(JSON.stringify(`cross-window-${throttling}`), failureFile);
    facts[`cross-window-${throttling}`] = await app.main(`(async()=>{
      const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(id)}),source=${app.win};
      ${diagnostics}
      await settles('initial capture',b.capture(t));
      t.view.webContents.setBackgroundThrottling(${throttling});t.driven=true;
      const first=b.capture(t);b.commandTab('covered',t.id,true);
      if(t.attached!==source || t.view.getVisible()) throw new Error('in-flight capture must stay hidden in its source window');
      await settles('visible-source capture',first);
      while(t.detachWait || t.attachWait) await settles('park',t.detachWait ?? t.attachWait);
      const parked=t.attached;
      if(!parked || parked===source) throw new Error('page did not move to the hidden window');
      const second=b.capture(t);b.commandTab('covered',t.id,false);
      if(t.attached!==parked || t.view.getVisible()) throw new Error('hidden-source capture must finish before returning');
      await settles('hidden-source capture',second);
      while(t.detachWait || t.attachWait) await settles('return',t.detachWait ?? t.attachWait);
      await settles('later capture',b.capture(t));
      const bounds=t.view.getBounds(),slot=t.slot;
      if(t.attached!==source || !t.view.getVisible() || !['x','y','width','height'].every(k=>Math.abs(bounds[k]-slot[k])<=1))
        throw new Error('returned view does not reach its slot');
      t.driven=false;t.view.webContents.setBackgroundThrottling(true);
      return {attached:true,bounds,slot};
    })()`);
  }
  // The bursts use the slot's own entry points: a gliding pane covers, moves and uncovers the page each frame;
  // a driven tab parks in the hidden agent window between frames; closing the area hides every tab.
  for (const variant of ["glide", "parked", "area"]) {
    const diagnostics = captureFailureHandlingSource(JSON.stringify(variant), failureFile);
    facts[variant] = await app.main(`(async()=>{
      const b=globalThis.browserAgentSubject, t=b.tabs.get(${JSON.stringify(id)}), wait=ms=>new Promise(r=>setTimeout(r,ms));
      ${diagnostics}
      const base={...t.slot}; let deferred=0;
      t.driven=${JSON.stringify(variant)}==='parked';
      for(round=0;round<5;round++){
        for(let i=0;i<20;i++){
          const slot={...base,x:base.x+(i%5)*7,width:base.width-(i%5)*7};
          if(${JSON.stringify(variant)}==='area'){b.hide();if(t.detachWait) deferred++;b.areaVisible=true;b.commandTab('bounds',t.id,slot);}
          else{b.commandTab('covered',t.id,true);if(t.detachWait) deferred++;b.commandTab('bounds',t.id,slot);b.commandTab('covered',t.id,false);}
        }
        b.commandTab('bounds',t.id,base);
        if(t.attachWait) deferred++;
        await settles('still capture',b.capture(t));
        while(t.attachWait || t.detachWait) await settles('re-attach',t.attachWait ?? t.detachWait);
        if(t.attached!==${app.win}) throw new Error('page did not return to the window');
        // The shell screenshot helper's own capture of the attached page, once it has painted.
        await settles('page paint',t.view.webContents.executeJavaScript("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))"));
        await settles('page capture',t.view.webContents.capturePage(undefined,{stayHidden:true}));
        await wait(50);
      }
      t.driven=false;
      return {deferred,attached:t.attached===${app.win},bounds:t.view.getBounds(),slot:base};
    })()`, 180_000);
  }
  writeFileSync(join(evidence, "capture-detach.json"), JSON.stringify(facts, null, 2));
  for (const [variant, fact] of Object.entries(facts).filter(([name]) => !name.startsWith("cross-window-")) as Array<[string, { deferred: number; attached: boolean }]>) {
    assert.ok(fact.deferred > 0, `${variant}: a re-attach met an in-flight capture`);
    assert.equal(fact.attached, true, `${variant}: the page is back in the window`);
  }
  await nativeAligned(app);
  // The still that stands in for the page during motion shows the page itself.
  const blue = await app.main<number>(`(async()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(id)});await b.capture(t);
    const image=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron').nativeImage.createFromDataURL(t.still);
    const p=image.getBitmap();let n=0;for(let i=0;i<p.length;i+=4)if(p[i]>180&&p[i+1]<150&&p[i+2]<120)n++;return n/(p.length/4)})()`);
  assert.ok(blue > 0.9, `still shows the page (${blue})`);
  // Closing destroys the contents rather than moving them: do not retain a view in a closing window.
  const closed = await app.main(`(async()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(id)});
    const pending=b.capture(t);b.close(t.id);await pending;
    return {removed:!b.tabs.has(t.id),attached:Boolean(t.attached),waiting:Boolean(t.detachWait)};})()`);
  assert.deepEqual(closed, { removed: true, attached: false, waiting: false });
} finally { fixture.stop(true); await app.stop(); }
