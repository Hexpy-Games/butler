// test-category: security
/** Canvas targets have no refs: real pixels, verified points and native input are required. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub } from "../support/browser-agent-stub";

const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);
const stub=browserStub(), app=await browserAgentApp(evidence, stub.handler);
try {
 await app.gateway.api("/settings", { method:"PATCH", body:JSON.stringify({ access_mode:"full_access" }) });
 const html=readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/canvas-only.html", "utf8");
 stub.set([
  ()=>({ name:"write_file", arguments:{ path:"canvas/index.html", content:html, create_parents:true } }),
  ()=>({ name:"output_publish", arguments:{ path:"canvas", title:"Canvas controls" } }),
 ]);
 await app.gateway.api("/messages", { method:"POST", body:JSON.stringify({ chat_id:"general", text:"Publish canvas fixture", client_message_id:crypto.randomUUID() }) });
 await waitBrowser(async()=>{const v=await app.gateway.api<{ latest_turn?:{ state:string } }>("/session-view?session_id=general");return v.latest_turn?.state==="delivered";}, "fixture publication");
 const outputs=await app.gateway.api<{ artifacts:Array<{ id:string;kind:string }> }>("/artifacts?session_id=general");
 const artifact=outputs.artifacts.find(a=>a.kind==="web");assert.ok(artifact);
 const view=await app.gateway.api<{ url:string }>(`/outputs/${artifact.id}/view`);
 await app.call("open");
 const invoke=(op:string, tab:string|undefined, args:unknown={})=>app.main<Record<string, any>>(`globalThis.browserAgentSubject.execute(${JSON.stringify({ op, tab, session:"general", args })})`);
 const opened=await invoke("tab.open", undefined, { url:view.url, policy:{ content_origin:new URL(view.url).origin } });
 assert.equal(opened.status, "ok");const tab=opened.tab as string;
 await app.main(`${app.win}.setContentSize(1100,900)`);
 await app.call("activate", { id: tab });
 await app.click("브라우저");
 await waitBrowser(() => app.main(`Boolean(globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).bounds?.scale < 1)`), "scaled native viewport");
 const observe=()=>invoke("tab.observe", tab, { include_image:true });
 let observation=await observe();assert.ok(observation.image?.data);
 assert.equal(observation.image_geometry.width, observation.image.width);
 assert.equal(observation.image_geometry.height, observation.image.height);
 assert.equal(observation.image_geometry.cssWidth, 1280);
 assert.equal(observation.image_geometry.cssHeight, 800);
 assert.equal(observation.nodes.filter((n:{ role:string })=>n.role!=="canvas").length, 0, "no DOM controls for canvas targets");
 const before=observation.image.data;
 let stepNumber=0;
 const execute=async(step:unknown, verifyPaint=false)=>{
  const previous=observation.image.data;
  const args={ observation:observation.obs, steps:[step] };
  const prepared=await invoke("tab.prepare", tab, args);assert.equal(prepared.status, "ok", JSON.stringify(prepared));
  const result=await invoke("tab.act", tab, { ...args, prepared_steps:prepared.steps });
  assert.equal(result.steps[0].status, "completed", JSON.stringify(result));
  observation=await observe();assert.ok(observation.image?.data, "every observation has fresh pixels");
  if(verifyPaint)assert.notEqual(observation.image.data,previous,"next screenshot confirms the canvas action changed its painted state");
  writeFileSync(join(evidence, `canvas-step-${++stepNumber}.jpg`),Buffer.from(observation.image.data,"base64"));
 };
 const sx=observation.image.width/1280, sy=observation.image.height/800;
 await execute({ action:"click", ref:observation.nodes[0].ref });
 assert.equal(await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript('state.clicked')`), false,
  "DOM-only canvas ref click cannot find the painted marker");
 await execute({ action:"click", point:[240*sx, 180*sy], expect:"canvas marker" },true);
 assert.notEqual(observation.image.data, before, "next screenshot confirms marker changed");
 await execute({ action:"drag", point:[460*sx, 300*sy], target_point:[760*sx, 300*sy], expect:"canvas map" },true);
 await execute({ action:"scroll", point:[900*sx, 600*sy], value:"120", expect:"canvas map" },true);
 const state=await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript('({...state})')`);
 assert.deepEqual(state, { clicked:true, dragged:true, scrolled:true });
 const mismatch=await invoke("tab.prepare", tab, { observation:observation.obs, steps:[{ action:"click", point:[0, 0], expect:"button pay" }] });
 assert.equal(mismatch.reason, "point_mismatch");
 writeFileSync(join(evidence, "canvas-result.json"), JSON.stringify({ state, imageWidth:observation.image.width, mismatch }));
 writeFileSync(join(evidence, "canvas-final.jpg"), Buffer.from(observation.image.data, "base64"));
 const crop=await invoke("tab.screenshot", tab, { observation:observation.obs, region:[160*sx, 100*sy, 180*sx, 150*sy] });
 assert.equal(crop.status, "ok");assert.ok(crop.image.width<observation.image.width);
 writeFileSync(join(evidence, "canvas-crop.jpg"), Buffer.from(crop.image.data, "base64"));
 const green=await app.main<boolean>(`(()=>{const image=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron').nativeImage.createFromDataURL('data:image/jpeg;base64,'+${JSON.stringify(crop.image.data)}),size=image.getSize(),p=image.getBitmap(),i=(Math.floor(size.height/2)*size.width+Math.floor(size.width/2))*4;return p[i+1]>120&&p[i+1]>p[i]*1.5&&p[i+1]>p[i+2]*1.5})()`);
 assert.equal(green, true, "crop covers the changed marker in screenshot coordinates at the scaled viewport");
} finally {await app.stop();}
