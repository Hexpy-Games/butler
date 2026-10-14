import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitBrowser, type browserAgentApp } from "./browser-agent-app";

type App=Awaited<ReturnType<typeof browserAgentApp>>;
/** Public archive closes its group and erases the last in-memory partition. */
export async function browserArchiveCheck(app: App, url: string, evidence: string) {
  const created=await app.gateway.api<{session:{id:string}}>("/sessions",{method:"POST",body:JSON.stringify({kind:"chat",title:"Archive browser"})});
  const session=created.session.id;
  const tab=await app.call<string>("create",{owner:`conversation:${session}`,url,profile:"signed_out"});
  await waitBrowser(()=>app.main<boolean>(`(()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)});return t.status==='idle' && !t.view.webContents.isLoading() && t.view.webContents.getURL()===t.url})()`),"user-opened tab loaded before handover");
  await app.call("control",{id:tab,holder:"agent"});
  await app.call("hide");
  await app.main(`(()=>{const browser=globalThis.browserAgentSubject,t=browser.tabs.get(${JSON.stringify(tab)});browser.detach(t);t.bounds={x:0,y:0,width:700,height:500,scale:1,visible:false}})()`);
  const admin=JSON.parse(await Bun.file(join(app.gateway.butlerData,"app/runtime/auth/local-admin.json")).text()).secret as string;
  const listed=await app.gateway.api<{tabs:Array<{id:string}>}>("/internal/browser/calls",{method:"POST",headers:{"x-butler-admin":admin},body:JSON.stringify({op:"tabs.list",session,args:{}})});
  assert.ok(listed.tabs.some(item=>item.id===tab));
  const observation=await app.gateway.api<{status:string}>("/internal/browser/calls",{method:"POST",headers:{"x-butler-admin":admin},body:JSON.stringify({op:"tab.observe",session,tab,args:{}})});
  const driven=await app.main(`(async()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)});return {agent:t.agent,driven:t.driven,size:await t.view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')}})()`);
  assert.equal(observation.status,"ok",JSON.stringify(observation));
  assert.deepEqual(driven,{agent:false,driven:true,size:{width:700,height:500}},"agent-driven user tabs retain their real viewport");
  const before=await app.main(`(async()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)});globalThis.archiveBrowserProfile=t.session;await t.session.cookies.set({url:'https://example.com',name:'archive-fixture',value:'fixture'});return {partition:t.partition,cookies:(await t.session.cookies.get({name:'archive-fixture'})).length}})()`);
  assert.equal((before as {cookies:number}).cookies,1);
  await app.gateway.api(`/sessions/${session}/archive`,{method:"POST",body:"{}"});
  await waitBrowser(()=>app.main(`!globalThis.browserAgentSubject.tabs.has(${JSON.stringify(tab)})`),"archive closes owned browser group");
  await waitBrowser(()=>app.main("globalThis.archiveBrowserProfile.cookies.get({}).then(cookies=>cookies.length===0)"),"last archived partition erases cookies");
  const after=await app.main(`({tabs:[...globalThis.browserAgentSubject.tabs.values()].filter(t=>t.owner===${JSON.stringify(`conversation:${session}`)}).length,partitionRetained:globalThis.browserAgentSubject.conversationPartitions.has(${JSON.stringify(`conversation:${session}`)})})`);
  assert.deepEqual(after,{tabs:0,partitionRetained:false});
  writeFileSync(join(evidence,"archive-partition.json"),JSON.stringify({driven,before,after},null,2));
}
