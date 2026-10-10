// test-category: race
/** Native held-button strokes, custom toolbar refs, screenshot crop and one reply image. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { shellReady } from "../support/browser-shell-acceptance";
import type { StubModelRequest } from "../support/native-app-server";

const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);
const baseline=process.env.BUTLER_PAINT_BASELINE==="1";
const extraCapture=process.env.BUTLER_PAINT_EXTRA_CAPTURE==="1";
const stub=browserStub();
const app=await browserAgentApp(evidence, stub.handler, undefined, { stubReply:request=>{
  const paths=JSON.stringify(request.messages).match(/artifacts\/public-data\/browser-[a-f0-9-]+\.jpg/gu);
  return paths?.length ? `![Drawing](${paths.at(-1)})` : "Ready";
} });
const observe=(r:StubModelRequest)=>bridgeBrowser("browser_observe", { tab:latestBrowser(r, "tab").tab });
const pick=(name:string)=>(r:StubModelRequest)=>{
  const o=latestBrowser(r, "obs"), text=(o.untrusted_content as { text:string }).text;
  if(name === "Close colors")assert.ok((text.match(/^image /gmu) ?? []).length>=100, "text scope retains every graphical dialog tile");
  const ref=new RegExp(`(?:element|button) "${name}" \\[([^\\]]+)\\]`, "u").exec(text)?.[1];assert.ok(ref, text);
  return bridgeBrowser("browser_act", { tab:o.tab, observation:o.obs, steps:[{ action:"click", ref }] });
};
const pickColor=(x:number, expect="element icon")=>(r:StubModelRequest)=>{
  const o=latestBrowser(r, "obs"), g=o.image_geometry as { width:number;height:number;cssWidth:number;cssHeight:number };
  assert.ok((o.untrusted_content as {text:string}).text.includes(`center=[${Math.round(x*g.width/g.cssWidth)},${Math.round(666*g.height/g.cssHeight)}] expect="element icon"`), "unlabeled controls expose usable screenshot centers and actual roles");
  return bridgeBrowser("browser_act", { tab:o.tab, observation:o.obs,
    steps:[{ action:"click", point:[x*g.width/g.cssWidth, 666*g.height/g.cssHeight], expect }] });
};
const paths=[[[260, 300], [480, 300]], [[480, 300], [480, 450]], [[480, 450], [260, 450]],
  [[260, 450], [260, 300]], [[260, 300], [370, 190]], [[370, 190], [480, 300]], [[650, 170], [740, 260]]];
function draw(indexes:number[]) {
  return (r:StubModelRequest)=>{
    const o=latestBrowser(r, "obs"), g=o.image_geometry as { width:number;height:number;cssWidth:number;cssHeight:number };
    const point=(p:number[])=>[p[0]*g.width/g.cssWidth, p[1]*g.height/g.cssHeight];
    return bridgeBrowser("browser_act", { tab:o.tab, observation:o.obs, steps:indexes.map(i=>({
      action:"drag", point:point(paths[i]![0]!), target_point:point(paths[i]![1]!), expect:"canvas Drawing",
    })) });
  };
}
const capture=(r:StubModelRequest)=>{
  const o=latestBrowser(r, "obs"), g=o.image_geometry as { width:number;height:number;cssWidth:number;cssHeight:number };
  return bridgeBrowser("browser_screenshot", { tab:o.tab, observation:o.obs,
    region:[80*g.width/g.cssWidth, 80*g.height/g.cssHeight, 850*g.width/g.cssWidth, 550*g.height/g.cssHeight] });
};
async function send(text:string) {
  const prior=await app.gateway.api<{ latest_turn?:{ id:string } }>("/session-view?session_id=general");
  await app.gateway.api("/messages", { method:"POST", body:JSON.stringify({ chat_id:"general", text, client_message_id:crypto.randomUUID() }) });
  await waitBrowser(async()=>{const v=await app.gateway.api<{ latest_turn?:{ id:string;state:string } }>("/session-view?session_id=general");return v.latest_turn?.id!==prior.latest_turn?.id&&v.latest_turn?.state==="delivered";}, "paint turn delivered");
}
try {
  await app.gateway.api("/settings", { method:"PATCH", body:JSON.stringify({ access_mode:"full_access", language:"ko" }) });
  const content=readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/paint.html", "utf8");
  stub.set([()=>({ name:"write_file", arguments:{ path:"paint/index.html", content, create_parents:true } }),
    ()=>({ name:"output_publish", arguments:{ path:"paint", title:"Pointer paint" } })]);
  await send("Publish paint fixture");
  const outputs=await app.gateway.api<{ artifacts:Array<{ id:string;kind:string }> }>("/artifacts?session_id=general");
  const artifact=outputs.artifacts.find(a=>a.kind==="web");assert.ok(artifact);
  const view=await app.gateway.api<{ url:string }>(`/outputs/${artifact.id}/view`);await app.call("open");
  await app.main(`${app.win}.setContentSize(1100,900)`);
  stub.set([
    ()=>({ name:"tool_describe", arguments:{ ids:["browser_open", "browser_observe", "browser_act", "browser_screenshot"].map(n=>`native:${n}`) } }),
    ()=>bridgeBrowser("browser_open", { url:view.url }), observe, pick("Colors"), observe,
    r=>{const o=latestBrowser(r, "tab");return bridgeBrowser("browser_observe", {tab:o.tab,scope:"text"});},
    pick("Close colors"), observe, pick("Line"), observe, pickColor(96, "canvas"), observe, pickColor(96), observe,
    r=>{const o=latestBrowser(r, "obs");return bridgeBrowser("browser_act", {tab:o.tab,observation:o.obs,steps:[{action:"drag",ref:"f0-e0",point:[200,200],target_point:[250,250],expect:"canvas"}]});},
    r=>{const o=latestBrowser(r, "obs");return bridgeBrowser("browser_act", {tab:o.tab,observation:o.obs,steps:[{action:"click",point:[200,200],expect:"element icon"}]});},
    r=>{const o=latestBrowser(r, "obs");return bridgeBrowser("browser_act", {tab:o.tab,observation:o.obs,steps:[{action:"drag",point:[200,200],target_point:[200,600],expect:"canvas"}]});},
    r=>{const o=latestBrowser(r, "obs");return bridgeBrowser("browser_act", {tab:o.tab,observation:o.obs,steps:Array.from({length:11},()=>({action:"click",point:[200,200],expect:"canvas"}))});},
    draw([0, 1, 2, 3, 4, 5]), observe, pick("Ellipse"), observe, pickColor(128), observe, draw([6]), observe,
    ...(extraCapture?[capture]:[]), capture,
  ]);
  await send("마우스로 집과 해를 그리고 캡처해줘.");
  writeFileSync(join(evidence, "tool-results.json"), JSON.stringify(stub.results));
  assert.deepEqual(stub.results.filter(r=>r&&typeof r==="object"&&"stubFailure" in r), []);
  assert.ok(JSON.stringify(stub.results).includes("point_mismatch"), "palette mismatch is refused before dispatch");
  assert.ok(JSON.stringify(stub.results).includes("use hit.ref if it is the intended control"), "mismatch preserves a concrete recovery path");
  assert.ok(JSON.stringify(stub.results).includes("exactly one of ref or point"), "ambiguous targets are refused with repair instructions");
  assert.ok(JSON.stringify(stub.results).includes("not a toolbar/palette control"));
  assert.ok(JSON.stringify(stub.results).includes("coordinate validation, not an input delivery failure"));
  assert.ok(JSON.stringify(stub.results).includes("rejected_point"));
  assert.ok(JSON.stringify(stub.results).includes("step_index"));
  assert.ok(JSON.stringify(stub.results).includes("existing text budget"), "budget refusal explains how to obtain complete fresh controls");
  const state=await app.call<{ tabs:Array<{ id:string;agent:boolean;inUse:boolean;busy:boolean }> }>("state");
  const tab=state.tabs.find(t=>t.agent);assert.ok(tab);assert.equal(tab.inUse, false);assert.equal(tab.busy, false);
  const paint=await app.main<{ strokes:Array<{ tool:string;color:string;released:boolean;points:Array<{ x:number;y:number;buttons:number;trusted:boolean }> }>;picks:Array<{ trusted:boolean }>;webgl:boolean }>(
    `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).view.webContents.executeJavaScript("paint")`);
  const observation=await app.main<{captureRegions:Array<{name:string;region:number[]}>}>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).observation`);
  assert.ok(observation.captureRegions.some((c:{name:string;region:number[]})=>c.name === "Drawing" && c.region.join(",") === "64,64,680,440"),"canvas crop hint uses screenshot coordinates");
  assert.equal(paint.webgl, true, "graphical web apps can initialize WebGL");
  writeFileSync(join(evidence, "stroke-paths.json"), JSON.stringify(paint));
  assert.equal(paint.strokes.length, paths.length);assert.equal(paint.picks.length, 4);
  assert.ok(paint.picks.every(p=>p.trusted));
  for(const [i, stroke] of paint.strokes.entries()) {
    assert.ok(stroke.released);assert.ok(stroke.points.length>=10, "drag includes intermediate moves");
    assert.equal(stroke.tool, i===6?"Ellipse":"Line");assert.equal(stroke.color, i===6?"#e87800":"#000");
    for(const p of stroke.points.slice(0, -1)){assert.equal(p.buttons, 1);assert.equal(p.trusted, true);}
    const [start, end]=paths[i]!;
    let last=0;
    for(const point of stroke.points){
      const dx=end![0]!-start![0]!, dy=end![1]!-start![1]!;
      const t=((point.x+80-start![0]!)*dx+(point.y+80-start![1]!)*dy)/(dx*dx+dy*dy);
      assert.ok(t>=last-0.01 && t<=1.01, "stroke moves toward its endpoint");last=t;
      assert.ok(Math.abs((point.x+80-start![0]!)*dy-(point.y+80-start![1]!)*dx)/Math.hypot(dx, dy)<2, "stroke follows the requested segment");
    }
    for(const [point, expected] of [[stroke.points[0]!, paths[i]![0]!], [stroke.points.at(-1)!, paths[i]![1]!]] as const) {
      assert.ok(Math.abs(point.x-(expected[0]!-80))<2);assert.ok(Math.abs(point.y-(expected[1]!-80))<2);
    }
  }
  await app.page.reload();
  await shellReady(app, "ko");
  await app.click("일반");
  await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="markdown-inline-image"]')));
  const count=await app.page.expression<number>("document.querySelectorAll('[data-test-class=markdown-inline-image]').length");assert.equal(count, extraCapture?2:1);
  assert.equal(await app.page.expression("document.querySelectorAll('[data-test-class=message-artifact-list]').length"), baseline?2:1, "image card is removed; web fixture card stays");
  if(!baseline)assert.equal(await app.page.expression("document.querySelectorAll('[data-test-class=message-image] :is(button,a)').length"), count, "save stays with every image");
  writeFileSync(join(evidence, "paint-result.json"), JSON.stringify({ paint, tab, count }));
  for(const language of ["ko", "en"])for(const theme of ["light", "dark"])for(const width of [1440, 1100]) {
    await app.gateway.api("/settings", { method:"PATCH", body:JSON.stringify({ language, appearance_theme:theme }) });
    await app.main(`${app.win}.setContentSize(${width},900)`);await app.page.reload();
    await shellReady(app, language);
    await app.click(language === "ko" ? "일반" : "General");
    await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="markdown-inline-image"]')));
    await app.page.waitForFunction(()=>[...document.querySelectorAll('[data-test-class="markdown-inline-image"]')].every(image=>image instanceof HTMLImageElement && image.complete && image.naturalWidth>0));
    await app.shot(`${baseline?"before":"after"}-${extraCapture?"extra-":""}${language}-${theme}-${width}`);
  }
}finally{await app.stop();}
