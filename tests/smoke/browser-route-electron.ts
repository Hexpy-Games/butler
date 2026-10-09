// test-category: race
/** Offline public user turn covers delayed autocomplete, waypoints, canvas route and reply. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
import type { StubModelRequest } from "../support/native-app-server";

const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);
const stub=browserStub(), app=await browserAgentApp(evidence, stub.handler);
async function send(text:string) {
 const prior=await app.gateway.api<{ latest_turn?:{ id:string } }>("/session-view?session_id=general");
 await app.gateway.api("/messages", { method:"POST", body:JSON.stringify({ chat_id:"general", text, client_message_id:crypto.randomUUID() }) });
 await waitBrowser(async()=>{const v=await app.gateway.api<{ latest_turn?:{ id:string;state:string } }>("/session-view?session_id=general");return v.latest_turn?.id!==prior.latest_turn?.id&&v.latest_turn?.state==="delivered";}, "delivered route turn");
}
const observe=(r:StubModelRequest)=>bridgeBrowser("browser_observe", { tab:latestBrowser(r, "tab").tab });
function act(role:string, name:string, value?:string) {
 return (r:StubModelRequest)=>{
  const o=latestBrowser(r, "obs"), text=(o.untrusted_content as { text:string }).text;
  const ref=new RegExp(`${role} "${name}" \\[([^\\]]+)\\]`, "u").exec(text)?.[1];assert.ok(ref, text);
  return bridgeBrowser("browser_act", { tab:o.tab, observation:o.obs, steps:[{ action:value===undefined?"click":"fill", ref, ...(value===undefined?{}:{ value }) }] });
 };
}
function lastResult(request:StubModelRequest) {
 const tool=request.messages.filter(m=>(m as {role?:string}).role==="tool").at(-1) as {content:unknown};
 const parts=tool.content as Array<{type:string;text:string}>;
 const value=JSON.parse(Array.isArray(parts)?parts.find(p=>p.type==="input_text")!.text:String(tool.content));
 return value.output ?? value;
}
try {
 await app.gateway.api("/settings", { method:"PATCH", body:JSON.stringify({ access_mode:"full_access", language:"ko" }) });
 const content=readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/route.html", "utf8");
 stub.set([()=>({ name:"write_file", arguments:{ path:"route/index.html", content, create_parents:true } }), ()=>({ name:"output_publish", arguments:{ path:"route", title:"Local directions" } })]);
 await send("Publish local route fixture");
 const outputs=await app.gateway.api<{ artifacts:Array<{ id:string;kind:string }> }>("/artifacts?session_id=general");
 const output=outputs.artifacts.find(a=>a.kind==="web");assert.ok(output);
 const view=await app.gateway.api<{ url:string }>(`/outputs/${output.id}/view`);await app.call("open");
 const steps=[
  ()=>({ name:"tool_describe", arguments:{ ids:["browser_open", "browser_observe", "browser_act", "browser_screenshot"].map(n=>`native:${n}`) } }),
  ()=>bridgeBrowser("browser_open", { url:view.url }), observe, act("button", "자동차"), observe,
  (r:StubModelRequest)=>{
   const first=act("textbox", "출발지", "중앙탑")(r).arguments.arguments as Record<string, unknown>;
   const last=act("textbox", "도착지", "수주팔봉")(r).arguments.arguments as Record<string, unknown>;
   return bridgeBrowser("browser_act", { ...first, steps:[...(first.steps as unknown[]), ...(last.steps as unknown[])] });
  },
  (r:StubModelRequest)=>{assert.ok(JSON.stringify(r.messages).includes("autocomplete_requires_observation"));return observe(r);},
  (r:StubModelRequest)=>{
   const text=(latestBrowser(r,"obs").untrusted_content as {text:string}).text;
   assert.match(text,/textbox "출발지" \[[^\]]+\] value=""/u);
   assert.match(text,/textbox "도착지" \[[^\]]+\] value=""/u);
   return act("textbox", "출발지", "중앙탑")(r);
  }, observe, act("textbox","도착지","수주팔봉"), (r:StubModelRequest)=>{
   // The row background covers the field; its actual option is a descendant.
   const result=lastResult(r);assert.equal(result.reason,"blocked_by");assert.equal(result.blocker.role,"li");assert.ok(result.blocker.controls.some((c:{role:string;name:string})=>c.role==="option"&&c.name==="중앙탑"));
   return observe(r);
  }, (r:StubModelRequest)=>{
   const text=(latestBrowser(r,"obs").untrusted_content as {text:string}).text;
   assert.match(text,/Visible editable fields, top to bottom \(2\):/u);
   assert.match(text,/2\. textbox "도착지" \[[^\]]+\] value="" covered_by .* not actionable/u);
   return act("option", "중앙탑")(r);
  }, observe,
  act("textbox", "도착지", "수주팔봉"), observe, act("option", "수주팔봉"), observe,
  act("button", "경유지 추가"), observe, act("button", "경유지 추가"), observe,
  act("textbox", "경유지 1", "떡버무리"), observe, act("option", "떡버무리"), observe,
  act("textbox", "경유지 2", "충주댐"), observe, act("option", "충주댐"), observe,
  act("button", "길찾기"), observe,
  (r:StubModelRequest)=>{const o=latestBrowser(r, "obs"), g=o.image_geometry as {width:number;height:number};return bridgeBrowser("browser_screenshot", { tab:o.tab, observation:o.obs, region:[0,0,g.width,g.height+1] });},
  (r:StubModelRequest)=>{
   const o=latestBrowser(r,"obs"), result=lastResult(r), g=o.image_geometry as {width:number;height:number};
   assert.equal(result.reason,"invalid_region");assert.equal(result.image_geometry.width,g.width);assert.equal(result.image_geometry.height,g.height);
   assert.match(result.recovery,/image_geometry/u);
   return bridgeBrowser("browser_screenshot", { tab:o.tab, observation:o.obs, region:[0,0,g.width,g.height] });
  },
  (r:StubModelRequest)=>{
   const o=latestBrowser(r,"obs"), result=lastResult(r);
   assert.equal(result.reason,"region_is_viewport","a crop cannot silently be the entire viewport");
   assert.match(result.recovery,/omit region/u);
   const regions=(o.untrusted_content as {capture_regions:Array<{region:number[]}>}).capture_regions;
   assert.deepEqual(regions[0].region,[32,0,992,640],"semantic navigation geometry provides a complete content crop");
   return bridgeBrowser("browser_screenshot", { tab:o.tab, observation:o.obs, region:regions[0].region });
  },
 ];
 stub.set(steps);await send("중앙탑 → 떡버무리 → 충주댐 → 수주팔봉 차량 경로를 짜고 캡처해서 보여줘.");
 assert.deepEqual(stub.results.filter(r=>r&&typeof r==="object"&&"stubFailure" in r),[]);
 assert.ok(JSON.stringify(stub.results).includes("autocomplete_requires_observation"));
 writeFileSync(join(evidence, "tool-results.json"), JSON.stringify(stub.results));
 const seen=new Set<string>(); let images=0, captures=0;
 for(const request of app.visionRequests ?? []) for(const item of request.body.input as Array<Record<string, any>>) {
  if(item.type!=="function_call_output" || seen.has(item.call_id)) continue;
  seen.add(item.call_id);
  const parts=Array.isArray(item.output)?item.output:[];
  const result=JSON.parse(parts.find((p:{ type:string })=>p.type==="input_text")?.text ?? (typeof item.output==="string"?item.output:"{}"));
  if(result.output?.schema==="butler.browser-capture.v1" && result.output.status==="ok") {
   assert.deepEqual(result.output.untrusted_content.fields.map((f:{value:string})=>f.value),["중앙탑","떡버무리","충주댐","수주팔봉"],"capture pixels and the source form state are delivered together");
   assert.ok(result.output.source_observation);
   assert.match(result.output.next,/retain the pictured page state/u);
   assert.ok(parts.some((p:{type:string;image_url?:string})=>p.type==="input_image" && p.image_url?.startsWith("data:image/jpeg;base64,")),"actual crop pixels reach model before replying");captures++;
  }
  if(result.output?.schema!=="butler.browser-observation.v1" || result.output.status!=="ok") continue;
  const fields=result.output.untrusted_content.fields;
  const geometry=result.output.image_geometry;
  assert.ok(geometry.width>0&&geometry.height>0&&geometry.cssWidth>0&&geometry.cssHeight>0,"actual screenshot coordinate space reaches the model with pixels");
  assert.ok(Array.isArray(fields));
  const total=/Visible editable fields, top to bottom \((\d+)\):/u.exec(result.output.untrusted_content.text)?.[1];
  assert.equal(fields.length,Number(total),"structured input state preserves covered fields and visible order");
  assert.ok(parts.some((p:{ type:string;image_url?:string })=>p.type==="input_image" && p.image_url?.startsWith("data:image/jpeg;base64,")), "every fresh observation reaches the model as actual image input");images++;
 }
 assert.equal(captures,1,"the reply crop is visually reviewable");
 assert.ok(images>=13, `only ${images} image observations delivered`);
 writeFileSync(join(evidence, "vision-carrier.json"), JSON.stringify({ images, captures, requests:app.visionRequests?.length }));
 const state=await app.call<{ tabs:Array<{ id:string;agent:boolean;inUse:boolean;busy:boolean }> }>("state");const tab=state.tabs.find(t=>t.agent);assert.ok(tab);
 assert.equal(tab.inUse, false);assert.equal(tab.busy, false);
 const summary=await app.main<string>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).view.webContents.executeJavaScript("document.querySelector('#summary').textContent")`);
 assert.equal(summary, "중앙탑 → 떡버무리 → 충주댐 → 수주팔봉 · 자동차 · 54km · 1시간 20분");
 const messages=await app.gateway.api<{ messages:Array<{ role:string;attachments?:Array<{ kind:string }> }> }>("/messages?chat_id=general");
 assert.ok(messages.messages.filter(m=>m.role==="assistant").at(-1)?.attachments?.some(a=>a.kind==="image"));
 writeFileSync(join(evidence, "route-result.json"), JSON.stringify({ summary, tab, actions:steps.length }));
}finally{await app.stop();}
