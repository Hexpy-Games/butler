// test-category: race
/** Real Electron lifecycle with a renderer reply held across document replacement. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const app = await browserAgentApp(evidence, () => null);
try {
  const results = await app.main<Array<{ stage: string; requested: boolean; settled: boolean; title: string; listeners: number[]; baseline: number[]; stale: boolean }>>(`(async()=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const {BrowserWindow}=require('electron');
    const {stepStill}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/stills.mjs"))});
    const rows=[];
    for(const stage of ['paint','capture']) {
      const window=new BrowserWindow({show:true,webPreferences:{backgroundThrottling:false}});
      const contents=window.webContents;
      const events=['did-start-navigation','render-process-gone','destroyed'];
      let release, pending;
      const originalPaint=contents.executeJavaScriptInIsolatedWorld.bind(contents);
      const originalCapture=contents.capturePage.bind(contents);
      try {
        await contents.loadURL('data:text/html,<title>Before</title><body style="background:red">Before');
        if(contents.isLoading())await new Promise(done=>contents.once('did-stop-loading',done));
        const baseline=events.map(name=>contents.listenerCount(name));
        let requested=false,settled=false,stale=false;
        const held=()=>{requested=true;return new Promise(done=>{release=done})};
        contents.executeJavaScriptInIsolatedWorld=stage==='paint'?held:async()=>true;
        if(stage==='capture')contents.capturePage=held;
        pending=stepStill({view:{webContents:contents},afterCapture:()=>{stale=true}}).then(()=>{settled=true});
        await new Promise(done=>setImmediate(done));
        await contents.loadURL('data:text/html,<title>After</title><body style="background:lime">After');
        await new Promise(done=>setImmediate(done));
        const releasedByNavigation=settled;
        release?.();await pending;await new Promise(done=>setImmediate(done));
        rows.push({stage,requested,settled:releasedByNavigation,title:contents.getTitle(),listeners:events.map(name=>contents.listenerCount(name)),baseline,stale});
      } finally {
        contents.executeJavaScriptInIsolatedWorld=originalPaint;contents.capturePage=originalCapture;
        release?.();await pending;window.destroy();
      }
    }
    return rows;
  })()`);
  writeFileSync(join(evidence, "lifecycle-results.json"), JSON.stringify(results, null, 2));
  for (const result of results) {
    assert.equal(result.requested, true, `${result.stage}: renderer reply was held`);
    assert.equal(result.title, "After");
    assert.equal(result.settled, true, `${result.stage}: navigation releases the old document's wait`);
    assert.equal(result.stale, false, `${result.stage}: no old bitmap reaches live frames`);
    assert.deepEqual(result.listeners, result.baseline, `${result.stage}: lifecycle listeners are removed`);
  }
  console.log("PASS navigation releases paint and capture waits without stale frames or listeners");
} finally { await app.stop(); }
