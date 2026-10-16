// test-category: race
/** Real Electron lifecycle: navigation, renderer crashes and synchronous dialogs. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const app = await browserAgentApp(evidence, () => null);
try {
  const results = await app.main<Array<{ stage: string; ending: string; requested: boolean; settled: boolean; title: string; image: boolean; listeners: number[]; baseline: number[]; stale: boolean }>>(`(async()=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const {BrowserWindow}=require('electron');
    const {stepStill}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/stills.mjs"))});
    const rows=[];
    for(const ending of ['navigation','crash']) for(const stage of ['paint','capture']) {
      const window=new BrowserWindow({show:true,webPreferences:{backgroundThrottling:false}});
      const contents=window.webContents;
      const events=['did-start-navigation','render-process-gone','destroyed'];
      const listeners=()=>[...events.map(name=>contents.listenerCount(name)),contents.debugger.listenerCount('message')];
      let release, pending;
      const originalPaint=contents.executeJavaScriptInIsolatedWorld.bind(contents);
      const originalCapture=contents.capturePage.bind(contents);
      try {
        await contents.loadURL('data:text/html,<title>Before</title><body style="background:red">Before');
        if(contents.isLoading())await new Promise(done=>contents.once('did-stop-loading',done));
        const baseline=listeners();
        let requested=false,settled=false,stale=false,image=false;
        const held=()=>{requested=true;return new Promise(done=>{release=done})};
        contents.executeJavaScriptInIsolatedWorld=stage==='paint'?held:async()=>true;
        if(stage==='capture')contents.capturePage=held;
        pending=stepStill({view:{webContents:contents},afterCapture:()=>{stale=true}}).then(value=>{image=Boolean(value);settled=true});
        await new Promise(done=>setImmediate(done));
        if(ending==='navigation')await contents.loadURL('data:text/html,<title>After</title><body style="background:lime">After');
        else {
          const crashed=new Promise(done=>contents.once('render-process-gone',done));
          contents.forcefullyCrashRenderer();await crashed;
        }
        await new Promise(done=>setImmediate(done));
        const releasedByEvent=settled;
        release?.();await pending;await new Promise(done=>setImmediate(done));
        rows.push({stage,ending,requested,settled:releasedByEvent,title:contents.getTitle(),image,listeners:listeners(),baseline,stale});
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
    if (result.ending === "navigation") assert.equal(result.title, "After");
    assert.equal(result.settled, true, `${result.ending}/${result.stage}: event releases the old document's wait`);
    assert.equal(result.image, false, `${result.ending}/${result.stage}: no stale image is returned`);
    assert.equal(result.stale, false, `${result.stage}: no old bitmap reaches live frames`);
    assert.deepEqual(result.listeners, result.baseline, `${result.stage}: lifecycle listeners are removed`);
  }
  const dialogs = await app.main<Array<{ mode: string; requested: number; image: boolean; stale: boolean; status?: string; reason?: string; existingImage: boolean; existingRequested: number; listeners: number[]; baseline: number[]; elapsedMs: number }>>(`(async()=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const {BrowserWindow}=require('electron');
    const {stepStill}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/stills.mjs"))});
    const {prepareBatch,actBatch}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/act.mjs"))});
    const {wireDialogs,resolveDialog}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/dialogs.mjs"))});
    const rows=[];
    for(const mode of ['still','act']) {
      const window=new BrowserWindow({show:true,webPreferences:{backgroundThrottling:false}});
      const contents=window.webContents;
      const originalPaint=contents.executeJavaScriptInIsolatedWorld.bind(contents);
      const events=['did-start-navigation','render-process-gone','destroyed'];
      const listeners=()=>[...events.map(name=>contents.listenerCount(name)),contents.debugger.listenerCount('message')];
      let requested=0,stale=false,timer;
      const tab={id:'dialog-tab',epoch:1,url:'about:blank',owner:'conversation:s1',holder:'agent',agent:true,
        view:{webContents:contents},afterCapture:()=>{stale=true}};
      const browser={publish(){},sync(){}};
      try {
        await contents.loadURL('data:text/html,<title>Dialog</title><body>Dialog');
        if(contents.isLoading())await new Promise(done=>contents.once('did-stop-loading',done));
        contents.debugger.attach('1.3');wireDialogs(browser,tab);
        await contents.debugger.sendCommand('Page.enable');
        const baseline=listeners();
        // Open a real native dialog in the first frame, before the paint promise's
        // second frame can run. The original production paint script still runs.
        contents.executeJavaScriptInIsolatedWorld=(world,scripts)=>{
          requested++;
          return originalPaint(world,scripts.map(script=>({...script,
            code:"requestAnimationFrame(()=>confirm('Paint wait'));"+script.code})));
        };
        const args={steps:[{action:'wait',value:'50'}]};
        const prepared=await prepareBatch(tab,args);args.prepared_steps=prepared.steps;
        const started=Date.now();
        const value=await Promise.race([
          mode==='act'?actBatch(tab,args,'s1'):stepStill(tab),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Dialog blocked the still wait')),5000)}),
        ]);
        clearTimeout(timer);
        const elapsedMs=Date.now()-started;
        if(!tab.dialog)throw Error('The real page dialog did not open');
        const existingImage=Boolean(await stepStill(tab));
        const existingRequested=requested;
        const row={mode,requested,image:Boolean(mode==='act'?value.steps[0].still:value),
          status:value?.status,reason:value?.steps?.[0]?.reason,existingImage,existingRequested,
          listeners:listeners(),baseline,elapsedMs};
        contents.executeJavaScriptInIsolatedWorld=originalPaint;
        await resolveDialog(browser,tab,{accept:false});
        // Let the cancelled renderer promise finish; it must not publish a bitmap.
        await originalPaint(9001,[{code:'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))'}]);
        rows.push({...row,stale});
      } finally {
        clearTimeout(timer);contents.executeJavaScriptInIsolatedWorld=originalPaint;
        if(tab.dialog)await resolveDialog(browser,tab,{accept:false});
        window.destroy();
      }
    }
    return rows;
  })()`);
  writeFileSync(join(evidence, "dialog-lifecycle-results.json"), JSON.stringify(dialogs, null, 2));
  for (const result of dialogs) {
    assert.equal(result.requested, 1, `${result.mode}: dialog opens during the paint wait`);
    assert.equal(result.image, false, `${result.mode}: no image is returned`);
    assert.equal(result.stale, false, `${result.mode}: no bitmap is published after answering`);
    assert.equal(result.existingImage, false, "an existing dialog returns no image");
    assert.equal(result.existingRequested, 1, "an existing dialog never asks the blocked renderer to paint");
    assert.deepEqual(result.listeners, result.baseline, `${result.mode}: lifecycle and debugger listeners are removed`);
    if (result.mode === "act") {
      assert.equal(result.status, "dialog_pending");
      assert.equal(result.reason, "dialog_pending");
    }
  }
  console.log("PASS navigation, renderer crash and dialogs release stills without stale frames or listeners; act returns dialog_pending");
} finally { await app.stop(); }
