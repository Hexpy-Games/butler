// test-category: race
/** Real Electron pixels, host recovery and shared-canvas isolation. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const app = await browserAgentApp(evidence, () => null);
try {
  await waitBrowser(() => app.main<boolean>(`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows().every(w=>w.webContents.getURL().startsWith('app://butler/'))`), "startup splash closed");
  const result = await app.main<any>(`(async()=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const {nativeImage,BrowserWindow,webContents}=require('electron');
    const stage=value=>process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(join(evidence, 'stages.txt'))},value+'\\n');
    const {markedImage,disposeMarkingHost,startMarkingHost}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/marking-host.mjs"))});
    const {encodeMarked}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/capture.mjs"))});
    const size={width:1813,height:1179},pixels=Buffer.alloc(size.width*size.height*4,255);
    const image=nativeImage.createFromBitmap(pixels,size);
    const marks=[{ref:'button-a',rect:{x:100,y:100,width:300,height:100}},
      {ref:'tiny',rect:{x:500,y:200,width:4,height:4}},
      {secure:true,rect:{x:700,y:300,width:200,height:100}}];
    const windows=()=>BrowserWindow.getAllWindows().map(w=>w.id);
    await disposeMarkingHost();startMarkingHost();
    const beforeWindows=windows(),beforeContents=webContents.getAllWebContents().map(c=>c.id);
    const focused=BrowserWindow.getFocusedWindow()?.id;
    const first=await markedImage(image,marks);stage('first');
    const host=webContents.getAllWebContents().find(c=>!beforeContents.includes(c.id));
    const hostId=host.id;
    const [plain,masked]=await Promise.all([markedImage(image,[]),markedImage(image,marks)]);
    stage('parallel');const sameHost=webContents.getAllWebContents().filter(c=>!beforeContents.includes(c.id)).map(c=>c.id);
    const offset=(350*size.width+800)*4;
    const maskedPixel=[...masked.toBitmap().subarray(offset,offset+4)];
    const plainPixel=[...plain.toBitmap().subarray(offset,offset+4)];
    const model=await encodeMarked(image,marks);stage('model');
    const decoded=nativeImage.createFromBuffer(Buffer.from(model.image.data,'base64'));
    const modelSize=decoded.getSize(),bytes=decoded.toBitmap();
    const x=Math.round(800*modelSize.width/size.width),y=Math.round(350*modelSize.height/size.height);
    const modelPixel=[...bytes.subarray((y*modelSize.width+x)*4,(y*modelSize.width+x)*4+4)];
    const crash=new Promise(done=>host.once('render-process-gone',done));
    host.forcefullyCrashRenderer();await crash;stage('crashed');
    await markedImage(image,marks);
    stage('recovered');const recovered=webContents.getAllWebContents().find(c=>!beforeContents.includes(c.id));
    const recoveredId=recovered.id;
    const destroyed=new Promise(done=>recovered.once('destroyed',done));
    recovered.close();await destroyed;stage('destroyed');
    await markedImage(image,marks);
    const recreated=webContents.getAllWebContents().find(c=>!beforeContents.includes(c.id)).id;
    const afterWindows=windows(),afterFocus=BrowserWindow.getFocusedWindow()?.id;
    const activeHost=webContents.getAllWebContents().find(c=>!beforeContents.includes(c.id));
    let entered;const called=new Promise(done=>{entered=done});
    activeHost.executeJavaScript=()=>{entered();return new Promise(()=>{})};
    const active=markedImage(image,marks).then(()=>false,()=>true);
    const queued=markedImage(image,[]).then(()=>false,()=>true);
    await called;await disposeMarkingHost();
    const rejected=await Promise.all([active,queued]);
    startMarkingHost();
    const translucent=nativeImage.createFromBitmap(Buffer.from([10,30,70,128]),{width:1,height:1});
    const alpha=[...(await markedImage(translucent,[])).toBitmap()];
    await disposeMarkingHost();
    const lateRejected=await markedImage(image,[]).then(()=>false,()=>true);
    const leaked=webContents.getAllWebContents().filter(c=>!beforeContents.includes(c.id)).map(c=>c.id);
    return {beforeWindows,afterWindows,focused,afterFocus,hostId,sameHost,recoveredId,recreated,leaked,
      rejected,lateRejected,alpha,fullSize:first.getSize(),maskedPixel,plainPixel,modelPixel,model:{...model.image,data:undefined}};
  })()`);
  writeFileSync(join(evidence, "marking-host.json"), JSON.stringify(result, null, 2));
  assert.deepEqual(result.afterWindows, result.beforeWindows);
  assert.equal(result.afterFocus, result.focused);
  assert.deepEqual(result.sameHost, [result.hostId]);
  assert.notEqual(result.recoveredId, result.hostId);
  assert.notEqual(result.recreated, result.recoveredId);
  assert.deepEqual(result.leaked, []);
  assert.deepEqual(result.rejected, [true,true]);
  assert.equal(result.lateRejected, true);
  assert.ok(result.alpha.every((v:number,n:number)=>Math.abs(v-[10,30,70,128][n]!)<=1));
  assert.deepEqual(result.fullSize, { width:1813, height:1179 });
  assert.deepEqual(result.maskedPixel, [0,0,0,255]);
  assert.deepEqual(result.plainPixel, [255,255,255,255]);
  assert.deepEqual(result.modelPixel, [0,0,0,255]);
  assert.equal(result.model.mime_type, "image/jpeg");
  assert.equal(result.model.width, 1024);
} finally { await app.stop(); }
