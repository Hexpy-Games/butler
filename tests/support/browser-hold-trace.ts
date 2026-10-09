// test-category: race
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlApp } from "./browser-control-actions";
import { pointerAction } from "./browser-control-actions";

/** rAF sees every painted state; MutationObserver also catches sub-frame releases. */
export async function startHoldTrace(app: ControlApp) {
  await app.main(`(() => {
    const b=globalThis.browserAgentSubject;
    globalThis.holdNativeSamples=[];globalThis.holdUseFrames=[];globalThis.holdNativeTracing=true;
    if(!globalThis.holdPublish){const publish=b.publish,execute=b.execute;
      globalThis.holdPublish=publish;
      b.publish=function(){const result=publish.call(this);if(globalThis.holdNativeTracing){
        const t=this.tabs.get(this.activeId);globalThis.holdNativeSamples.push({time:Date.now(),
          inUse:this.snapshot().tabs.find(tab=>tab.id===t?.id)?.inUse,calls:this.uses.size,
          pointer:t?.pointer?.mode ?? null,at:t?.pointer?.at,attached:Boolean(this.pointer.attached)});
      }return result};
      b.execute=function(frame){if(globalThis.holdNativeTracing)globalThis.holdUseFrames.push({op:frame.op,turn:frame.turn_id,session:frame.session});return execute.call(this,frame)};
    }
  })()`);
  await app.page.expression(`(() => {
    window.holdSamples=[];window.holdTracing=true;
    const sample=source=>{const card=document.querySelector('[data-slot=page-card]');
      if(!card)return;const edge=getComputedStyle(card,'::after'),r=card.getBoundingClientRect();
      window.holdSamples.push({time:performance.now(),source,holder:card.dataset.holder,
        band:document.querySelector('[data-test-class=browser-agent-control]')?.dataset.tone ?? null,
        edge:{inset:edge.inset,animation:edge.animationName,background:edge.backgroundImage},
        rect:{x:r.x,y:r.y,width:r.width,height:r.height}});};
    const frame=()=>{if(window.holdTracing){sample('frame');requestAnimationFrame(frame)}};
    window.holdObserver=new MutationObserver(()=>sample('mutation'));
    window.holdObserver.observe(document.querySelector('[data-slot=page-card]'),{attributes:true,childList:true,subtree:true});
    requestAnimationFrame(frame);
  })()`);
}

type Sample = { time: number; holder: string; band: string | null; source: string; rect: Record<string, number>; edge: { inset: string } };
export async function finishHoldTrace(app: ControlApp, evidence: string, name: string, baseline = false, minimumGaps = 10) {
  const samples = await app.page.expression<Sample[]>("(()=>{window.holdTracing=false;window.holdObserver.disconnect();return window.holdSamples})()");
  writeFileSync(join(evidence, `${name}-frames.json`), JSON.stringify(samples));
  const frames = samples.filter(sample => sample.source === "frame");
  const first = frames.findIndex(sample => sample.holder === "butler");
  const last = frames.findLastIndex(sample => sample.holder === "butler");
  assert.ok(first >= 0);
  const offFrames = frames.slice(first, last + 1).filter(sample => sample.holder !== "butler" || sample.band !== "agent");
  const releases = frames.filter((sample, index) => index > 0 && frames[index-1]!.holder === "butler" && sample.holder === "none").length;
  const anchor = frames[first]!;
  const geometryChanges = frames.slice(first, last+1).filter(sample => sample.edge.inset !== anchor.edge.inset ||
    Object.keys(anchor.rect).some(key => Math.abs(sample.rect[key]! - anchor.rect[key]!) > 1)).length;
  const summary = { frames: frames.length, durationMs: frames.at(-1)!.time - frames[0]!.time, offFrames: offFrames.length, releases, geometryChanges };
  const native = await app.main<{ samples: Array<{ inUse: boolean; calls: number; pointer: string; attached: boolean }>; frames: Array<{ op: string }> }>("(()=>{globalThis.holdNativeTracing=false;return {samples:globalThis.holdNativeSamples,frames:globalThis.holdUseFrames}})()");
  writeFileSync(join(evidence, `${name}-native.json`), JSON.stringify(native));
  writeFileSync(join(evidence, `${name}-summary.json`), JSON.stringify(summary));
  if (!baseline) {
    assert.equal(offFrames.length, 0); assert.equal(releases, 1); assert.equal(geometryChanges, 0);
    const gaps = native.samples.filter(sample => sample.inUse && sample.calls === 0);
    assert.ok(gaps.length >= minimumGaps);
    assert.ok(gaps.every(sample => sample.pointer === "parked" && sample.attached), "every call gap keeps a parked native overlay");
    assert.equal(native.frames.filter(frame => frame.op === "use.finished").length, 1);
  }
  return summary;
}

/** Capture actual native compositor frames without moving focus or the pointer. */
export async function windowFrames(app: ControlApp, evidence: string, name: string, count = 12) {
  const capture = process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE; assert.ok(capture);
  const source = (await app.main<string>(`${app.win}.getMediaSourceId()`)).split(":")[1]!;
  const started = Date.now(), times: number[] = [];
  for (let index = 0; index < count; index++) {
    const child: Bun.Subprocess<"ignore", "ignore", "pipe"> = Bun.spawn([capture, source, join(evidence, `${name}-${String(index).padStart(2, "0")}.png`)], { stdin:"ignore", stdout:"ignore", stderr:"pipe" });
    assert.equal(await child.exited, 0, await new Response(child.stderr).text());
    times.push(Date.now()-started);
  }
  writeFileSync(join(evidence, `${name}-times.json`), JSON.stringify(times));
}

/** Record target vs pointer geometry, distinguishing native bounds from DS motion. */
export async function pointerFrames(app: ControlApp, milliseconds = 650) {
  return app.main(`globalThis.browserAgentSubject.pointer.view.webContents.executeJavaScript(${JSON.stringify(`new Promise(done=>{
    const frames=[],start=performance.now(),sample=()=>{
      const layer=document.querySelector('[data-slot=agent-pointer]'),pointer=layer?.lastElementChild;
      const ring=layer?.querySelector('div[style*="width"]');
      const read=node=>{if(!node)return null;const r=node.getBoundingClientRect(),s=getComputedStyle(node);
        return {x:r.x,y:r.y,width:r.width,height:r.height,translate:s.translate,transition:s.transitionDuration,inline:node.getAttribute('style')}};
      frames.push({time:performance.now()-start,mode:layer?.dataset.mode,pointer:read(pointer),ring:read(ring),width:innerWidth,height:innerHeight});
      if(performance.now()-start<${milliseconds})requestAnimationFrame(sample);else done(frames);
    };requestAnimationFrame(sample);
  })`)})`);
}

/** Measure the existing DS glide on actual gateway steps, without remounting its presenter. */
export async function verifyPointerGlide(app: ControlApp, tab: string, evidence: string) {
  await app.main(`globalThis.browserAgentSubject.execute({op:'use.started',id:'glide-presentation',session:'general',tab:${JSON.stringify(tab)}})`);
  const overlay = "globalThis.browserAgentSubject.pointer.view.webContents";
  try {
    await pointerAction(app, tab, "click");
    await app.main(`${overlay}.executeJavaScript("new Promise(done=>setTimeout(()=>done(true),450))")`);
    await app.main(`${overlay}.executeJavaScript(${JSON.stringify(`(() => {
      window.glideFrames=[];window.glideNode=document.querySelector('[data-slot=agent-pointer] > :last-child');window.glideRecording=true;
      const sample=()=>{if(!window.glideRecording)return;const node=document.querySelector('[data-slot=agent-pointer] > :last-child'),r=node.getBoundingClientRect();
        window.glideFrames.push({time:performance.now(),x:r.x,y:r.y,same:node===window.glideNode,duration:getComputedStyle(node).transitionDuration});requestAnimationFrame(sample)};
      sample();return true;
    })()` )})`);
    await pointerAction(app, tab, "fill");
    await app.main(`${overlay}.executeJavaScript("new Promise(done=>setTimeout(()=>done(true),450))")`);
    const frames = await app.main<Array<{ x: number; same: boolean; duration: string }>>(`${overlay}.executeJavaScript("(()=>{window.glideRecording=false;return window.glideFrames})()")`);
    writeFileSync(join(evidence, "pointer-glide-frames.json"), JSON.stringify(frames));
    const first = frames[0]!.x, last = frames.at(-1)!.x;
    const intermediate = frames.filter(frame => frame.x > Math.min(first, last)+1 && frame.x < Math.max(first, last)-1).length;
    assert.ok(Math.abs(first-last)>20); assert.ok(intermediate>0); assert.ok(frames.every(frame=>frame.same && frame.duration === "0.4s"));
    return { frames: frames.length, intermediate, duration: "400ms", samePresenter: true };
  } finally { await app.main("globalThis.browserAgentSubject.execute({op:'use.ended',args:{id:'glide-presentation'}})"); }
}
