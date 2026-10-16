// test-category: race
/** Real Electron lifecycle: navigation, destruction, renderer crashes and synchronous dialogs. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const app = await browserAgentApp(evidence, () => null);
try {
  const results = await app.main<Array<{ stage: string; ending: string; mode: string; status?: string; stepStatus?: string; reason?: string; requested: boolean; settled: boolean; title: string; image: boolean; listeners: number[]; baseline: number[]; stale: boolean }>>(`(async()=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const {BrowserWindow}=require('electron');
    const {stepStill}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/stills.mjs"))});
    const {prepareBatch,actBatch}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/act.mjs"))});
    const {beginDialog,answerDialog}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/dialogs.mjs"))});
    const rows=[];
    for(const ending of ['navigation','crash','destroy']) for(const stage of ['paint','capture']) for(const mode of ending==='destroy'?['still','act','answer']:['still']) {
      const window=new BrowserWindow({show:true,webPreferences:{backgroundThrottling:false}});
      const contents=window.webContents,dbg=contents.debugger;
      const events=['did-start-navigation','render-process-gone','destroyed'];
      const listeners=()=>[...events.map(name=>contents.listenerCount(name)),dbg.listenerCount('message'),tab.dialogWaiters?.size??0];
      let release, pending, value;
      const tab={id:'lifecycle-tab',epoch:1,url:'about:blank',owner:'conversation:s1',holder:'agent',view:{webContents:contents}};
      const browser={publish(){},sync(){}};
      const originalPaint=contents.executeJavaScriptInIsolatedWorld.bind(contents);
      const originalCapture=contents.capturePage.bind(contents);
      try {
        await contents.loadURL('data:text/html,<title>Before</title><body style="background:red">Before');
        if(contents.isLoading())await new Promise(done=>contents.once('did-stop-loading',done));
        const baseline=listeners();
        let requested=false,settled=false,stale=false,image=false;
        let paintRequested;
        const ready=new Promise(done=>{paintRequested=done});
        const held=()=>{requested=true;paintRequested();return new Promise(done=>{release=done})};
        contents.executeJavaScriptInIsolatedWorld=stage==='paint'?held:async()=>true;
        if(stage==='capture')contents.capturePage=held;
        tab.afterCapture=()=>{stale=true};
        const args={steps:[{action:'wait',value:'50'}]};
        args.prepared_steps=(await prepareBatch(tab,args)).steps;
        if(mode==='answer') {
          beginDialog(browser,tab,{type:'confirm',message:'First'},()=>{});
          tab.pendingBatch=[{status:'unknown',reason:'dialog_pending'}];
        }
        pending=(mode==='act'?actBatch(tab,args,'s1'):mode==='answer'?answerDialog(browser,tab,{dialog:tab.dialog.id,accept:true}):stepStill(tab))
          .then(result=>{value=result;image=Boolean(mode==='still'?result:result.steps[0].still);settled=true});
        await ready;
        if(ending==='navigation')await contents.loadURL('data:text/html,<title>After</title><body style="background:lime">After');
        else if(ending==='destroy') {
          const destroyed=new Promise(done=>contents.once('destroyed',done));
          window.destroy();await destroyed;
        }
        else {
          const crashed=new Promise(done=>contents.once('render-process-gone',done));
          contents.forcefullyCrashRenderer();await crashed;
        }
        await new Promise(done=>setImmediate(done));
        const releasedByEvent=settled;
        release?.();await pending;await new Promise(done=>setImmediate(done));
        rows.push({stage,ending,mode,requested,settled:releasedByEvent,title:contents.isDestroyed()?'':contents.getTitle(),image,listeners:listeners(),baseline,stale,status:value?.status,stepStatus:value?.steps?.[0]?.status,reason:value?.steps?.[0]?.reason});
      } finally {
        if(!contents.isDestroyed()){contents.executeJavaScriptInIsolatedWorld=originalPaint;contents.capturePage=originalCapture;}
        release?.();await pending;if(!window.isDestroyed())window.destroy();
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
    assert.deepEqual(result.listeners, result.baseline, `${result.ending}/${result.stage}/${result.mode}: listeners return to baseline`);
    if (result.mode !== "still") {
      assert.equal(result.status, "ok");
      assert.equal(result.stepStatus, "completed", "destroying the contents does not rewrite a completed step");
      assert.equal(result.reason, undefined);
    }
  }
  const dialogs = await app.main<Array<{ mode: string; source: string; waiting: boolean; pending: boolean; nextDialog?: string; requested: number; image: boolean; stale: boolean; status?: string; reason?: string; existingImage: boolean; existingRequested: number; listeners: number[]; baseline: number[]; elapsedMs: number }>>(`(async()=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const {BrowserWindow}=require('electron');
    const {stepStill}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/stills.mjs"))});
    const {prepareBatch,actBatch}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/act.mjs"))});
    const {wireDialogs,resolveDialog,answerDialog}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/dialogs.mjs"))});
    const {wireUserDialogs}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/user-dialogs.mjs"))});
    const rows=[];
    for(const source of ['cdp','electron']) for(const mode of ['still','act','answer']) {
      const window=new BrowserWindow({show:true,webPreferences:{backgroundThrottling:false}});
      const contents=window.webContents,dbg=contents.debugger;
      const originalPaint=contents.executeJavaScriptInIsolatedWorld.bind(contents);
      const events=['did-start-navigation','render-process-gone','destroyed'];
      const listeners=()=>[...events.map(name=>contents.listenerCount(name)),dbg.listenerCount('message'),tab.dialogWaiters?.size??0];
      let requested=0,stale=false,timer;
      const tab={id:'dialog-tab',epoch:1,url:'about:blank',owner:'conversation:s1',holder:'agent',agent:true,
        view:{webContents:contents},afterCapture:()=>{stale=true}};
      const browser={publish(){},sync(){},detach(){},close(){}};
      try {
        await contents.loadURL('data:text/html,<title>Dialog</title><body>Dialog');
        if(contents.isLoading())await new Promise(done=>contents.once('did-stop-loading',done));
        wireUserDialogs(browser,tab);
        if(source==='cdp'){dbg.attach('1.3');wireDialogs(browser,tab);await dbg.sendCommand('Page.enable');}
        if(mode==='answer') {
          const opened=new Promise(done=>contents.once('-run-dialog',()=>setImmediate(done)));
          await originalPaint(9001,[{code:"setTimeout(()=>confirm('First dialog'),0);true"}]);
          await opened;
          tab.pendingBatch=[{status:'unknown',reason:'dialog_pending'}];
        }
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
          mode==='act'?actBatch(tab,args,'s1'):mode==='answer'?answerDialog(browser,tab,{dialog:tab.dialog.id,accept:true}):stepStill(tab),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Dialog blocked the still wait')),5000)}),
        ]);
        clearTimeout(timer);
        const elapsedMs=Date.now()-started;
        if(!tab.dialog)throw Error('The real page dialog did not open');
        const existingImage=Boolean(await stepStill(tab));
        const existingRequested=requested;
        const row={mode,source,waiting:tab.waiting,pending:Boolean(tab.pendingBatch),nextDialog:value?.dialog?.message,requested,image:Boolean(mode==='still'?value:value.steps[0].still),
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
    assert.equal(result.waiting, true, "the open dialog keeps the tab waiting");
    assert.equal(result.requested, 1, `${result.mode}: dialog opens during the paint wait`);
    assert.equal(result.image, false, `${result.mode}: no image is returned`);
    assert.equal(result.stale, false, `${result.mode}: no bitmap is published after answering`);
    assert.equal(result.existingImage, false, "an existing dialog returns no image");
    assert.equal(result.existingRequested, 1, "an existing dialog never asks the blocked renderer to paint");
    assert.deepEqual(result.listeners, result.baseline, `${result.mode}: lifecycle and debugger listeners are removed`);
    if (result.mode !== "still") {
      assert.equal(result.status, "dialog_pending");
      assert.equal(result.pending, true, "the batch is retained for the pending dialog");
      assert.equal(result.nextDialog, "Paint wait");
      if (result.mode === "act") assert.equal(result.reason, "dialog_pending");
    }
  }
  console.log(`PASS ${results.length} lifecycle and ${dialogs.length} dialog rows: destruction preserves completed steps; both dialog sources release waits; second dialogs stay pending`);
} finally { await app.stop(); }
