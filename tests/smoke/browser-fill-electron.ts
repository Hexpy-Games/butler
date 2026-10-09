/** Repeat-fill correctness with the native pointer layer present. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { describeBrowser, bridgeBrowser } from "../support/browser-agent-stub";
import { pointerAction, holdObservation } from "../support/browser-control-actions";
import { nativeAligned } from "../support/browser-shell-acceptance";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
try {
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url })]);
  await app.send("Open the fill fixture"); await app.delivered();
  const state = await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state");
  const tab = state.tabs.find(item => item.agent)!.id;
  await app.call("activate", { id: tab }); await app.click("Browser"); await nativeAligned(app);
  const values = [];
  for (let n = 0; n < 3; n++) {
    await pointerAction(app, tab, "click"); await pointerAction(app, tab, "fill");
    const value = await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("document.querySelector('input').value")`);
    values.push(value); assert.equal(value, "Fixture note");
  }
  const release = await holdObservation(app, tab);
  const guard = await app.main<{ attached: boolean; holder: string; text: string }>(`(async()=>{
    const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab)}),p=b.pointer;
    await t.view.webContents.executeJavaScript("document.getElementById('result').textContent='Ready'");
    p.ready=false;p.hide();p.sync(t);
    p.view.webContents.sendInputEvent({type:'mouseDown',x:40,y:40,button:'left',clickCount:1});
    p.view.webContents.sendInputEvent({type:'mouseUp',x:40,y:40,button:'left',clickCount:1});
    await new Promise(done=>setTimeout(done,50));
    const result={attached:p.attached===t.attached,holder:t.holder,text:await t.view.webContents.executeJavaScript("document.getElementById('result').textContent")};
    p.ready=true;p.sync(t);return result;
  })()`);
  assert.equal(guard.attached, true, "input is guarded before presenter readiness"); assert.equal(guard.holder, "agent"); assert.equal(guard.text, "Ready"); await release();
  const userInput = await app.main<{ holder: string; text: string; focus: boolean }>(`(async()=>{
    const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab)}),contents=t.view.webContents;
    const rect=await contents.executeJavaScript("(()=>{document.getElementById('result').textContent='Ready';return document.getElementById('confirm').getBoundingClientRect().toJSON()})()");
    const point={x:Math.round((rect.x+rect.width/2)*t.bounds.scale),y:Math.round((rect.y+rect.height/2)*t.bounds.scale)};
    b.pointer.view.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
    b.pointer.view.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
    await new Promise(done=>setTimeout(done,50));
    return {holder:t.holder,text:await contents.executeJavaScript("document.getElementById('result').textContent"),focus:contents.isFocused()};
  })()`);
  assert.equal(userInput.holder, "user"); assert.equal(userInput.text, "Confirmed"); assert.equal(userInput.focus, true, "native page retains keyboard and IME input");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, values, guard, userInput }));
} finally {
  await app.stop();
}
