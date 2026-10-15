// test-category: race
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";

const evidence=process.env.BUTLER_BROWSER_EVIDENCE, url=process.env.BUTLER_BROWSER_MEDIA_URL;
assert.ok(evidence); assert.ok(url);
const app=await browserAgentApp(evidence,()=>null);
try {
  await app.click("브라우저");
  const id=await app.call<string>("create",{url});
  const contents=`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents`;
  await waitBrowser(()=>app.main<boolean>(`${contents}.executeJavaScript("Boolean(document.querySelector('video')?.readyState>=2)")`).catch(()=>false),"media ready");
  await app.main(`${contents}.executeJavaScript("(async()=>{const v=document.querySelector('video');v.muted=true;v.loop=true;await v.play();return true})()")`);
  await app.call("create");
  await waitBrowser(()=>app.main<boolean>(`!${contents}.getBackgroundThrottling()`),"playing media remains active in background");
  const samples:Array<{paused:boolean;time:number;duration:number;visibility:string}>=[];
  for(let n=0;n<6;n++) {
    await Bun.sleep(5000);
    const sample=await app.main<typeof samples[number]>(`${contents}.executeJavaScript("(()=>{const v=document.querySelector('video');return {paused:v.paused,time:v.currentTime,duration:v.duration,visibility:document.visibilityState}})()")`);
    samples.push(sample);assert.equal(sample.paused,false);
    if(n)assert.notEqual(sample.time,samples[n-1]!.time,"background video keeps advancing through loops");
  }
  assert.ok(samples[0]!.duration>0 && samples[0]!.duration<15,"short loop fixture exercises multiple restarts");
  await app.main(`${contents}.executeJavaScript("document.querySelector('video').pause();true")`);
  await waitBrowser(()=>app.main<boolean>(`${contents}.getBackgroundThrottling()`),"paused user tab returns to idle throttling");
  writeFileSync(join(evidence,"media-lifecycle.json"),JSON.stringify({samples,idleThrottling:true},null,2));
} finally {await app.stop();}
