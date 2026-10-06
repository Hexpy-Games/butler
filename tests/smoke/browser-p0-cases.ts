import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { budget, frames, percentile, sample, startFrames, typing, prepareTyping, attributeTrace, type P0App, type Row } from "./browser-p0-measure.ts";
import { seedP0OwnerScale } from "./browser-p0-owner-scale.ts";
import { waitFor, P0_STUB_CONTENT } from "./browser-p0-app.ts";

export async function rendererCrash(app: P0App, origin: string, rows: Row[]) {
  await app.main.evaluate(`browserP0.open('crash', '${origin}/nodes')`);
  const before = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
  await startFrames(app);
  await app.main.evaluate("browserP0.crashRenderer('crash')");
  await Bun.sleep(2000);
  const state = await sample(app);
  assert(state.crashes.some(c => c.id === "crash" && c.code === "tab_crashed"));
  assert(await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')") > before);
  budget(rows, "renderer", "UI frame gap ms", Math.max(...await frames(app)), 2000, "Blink renderer isolation", "Investigate renderer sharing");
  await app.main.evaluate("browserP0.close('crash')");
}

export async function gpuCrash(app: P0App, origin: string, rows: Row[]) {
  await app.main.evaluate(`browserP0.open('gpu', '${origin}/gpu')`);
  const before = await sample(app);
  const policy = await app.main.evaluate<{ webgl: boolean; webgpu: boolean }>("browserP0.gpuPolicy('gpu')");
  const webgpu = policy.webgpu;
  if (process.env.BUTLER_P0_AGENT_GPU === "off") {
    for (const feature of ["webgl", "webgpu"] as const) rows.push({ test: "gpu crash", metric: `agent ${feature} disabled`, value: String(policy[feature]), budget: "false", status: policy[feature] ? "FAIL" : "PASS", attribution: "Electron per-view capability policy", mitigation: "Verify a supported per-view GPU policy before treating this as a mitigation run" });
  }
  await startFrames(app);
  await app.page.expression("(()=>{window.p0WallpaperDraws=0;const p=WebGL2RenderingContext.prototype,draw=p.drawArrays;p.drawArrays=function(...args){window.p0WallpaperDraws++;return draw.apply(this,args)}})()");
  await Bun.sleep(1000);
  assert(await app.page.expression<number>("window.p0WallpaperDraws") > 0, "Animated Butler wallpaper must be drawing");
  // Loss storms do not reliably crash the process; chrome://gpucrash makes
  // each process loss deterministic while keeping the fixture workload.
  for (let i = 0; i < 5; i++) {
    const wallpaperBefore = await app.page.expression<number>("window.p0WallpaperDraws");
    const userBefore = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
    const count = (await sample(app)).gone.filter(p => p.type === "GPU").length;
    const lossAt = performance.now();
    await app.main.evaluate("browserP0.loseGPU('gpu')");
    await waitFor(async () => (await sample(app)).gone.filter(p => p.type === "GPU").length > count, "GPU process loss");
    const painted = await app.main.evaluate("browserP0.paintProbe()").then(() => true as const, error => String(error));
    if (painted === true) budget(rows, "gpu crash", `UI pixel recovery loss ${i + 1} ms`, performance.now() - lossAt, 2000, "GPU/Blink compositor", "Disable agent WebGL/WebGPU");
    else rows.push({ test: "gpu crash", metric: `UI pixel recovery loss ${i + 1}`, value: painted, budget: "latest pixel painted <=2000 ms", status: "FAIL", attribution: "GPU/Blink compositor", mitigation: "Disable agent WebGL/WebGPU" });
    await Bun.sleep(2000);
    await app.main.evaluate(`browserP0.navigate('gpu', '${origin}/gpu')`);
    const state = await sample(app);
    const wallpaperAfter = await app.page.expression<number>("window.p0WallpaperDraws");
    const userAfter = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
    rows.push({ test: "gpu crash", metric: `wallpaper resumed loss ${i + 1}`, value: wallpaperAfter - wallpaperBefore, budget: ">0 draw calls", status: wallpaperAfter > wallpaperBefore ? "PASS" : "FAIL", attribution: "Butler wallpaper WebGL context after GPU loss", mitigation: "Disable agent WebGL/WebGPU; verify context restoration" });
    rows.push({ test: "gpu crash", metric: `user video resumed loss ${i + 1}`, value: userAfter - userBefore, budget: ">0 decoded frames", status: userAfter > userBefore ? "PASS" : "FAIL", attribution: "GPU/Blink video recovery", mitigation: "Disable agent WebGL/WebGPU" });
    rows.push({ test: "gpu crash", metric: `GPU feature status loss ${i + 1}`, value: JSON.stringify(state.gpu), budget: JSON.stringify(before.gpu), status: JSON.stringify(state.gpu) === JSON.stringify(before.gpu) ? "PASS" : "FAIL", attribution: "GPU", mitigation: "Disable agent WebGL/WebGPU, then repeat" });
    console.log(JSON.stringify({ gpuLoss: i + 1, wallpaperDraws: wallpaperAfter - wallpaperBefore, userFrames: userAfter - userBefore, featuresUnchanged: JSON.stringify(state.gpu) === JSON.stringify(before.gpu) }));
    // Spread five losses over ten minutes, rather than changing the crash-rate gate.
    await Bun.sleep(118_000);
  }
  const after = await sample(app);
  budget(rows, "gpu crash", "UI frame gap ms", Math.max(...await frames(app)), 2000, "GPU", "Disable agent WebGL/WebGPU");
  assert.equal(after.gone.filter(p => p.type === "GPU").length - before.gone.filter(p => p.type === "GPU").length, 5);
  await app.main.evaluate("browserP0.close('gpu')");
  return { policy, webgpu, losses: after.gone.filter(p=>p.type==="GPU"), uiMaxGapMs: Math.max(...await frames(app)) };
}

export async function gpuHang(app: P0App, origin: string, rows: Row[]) {
  await app.main.evaluate(`browserP0.open('hang', '${origin}/hang')`);
  await app.main.evaluate("browserP0.evaluate('hang','prepare()')");
  const before = await sample(app);
  await startFrames(app);
  // Do not await the GPU queue: the watchdog, not the test, must break the hang.
  const stalled = app.main.evaluate("browserP0.evaluate('hang','stall()')").catch(error => ({ error: String(error) }));
  const paint = app.main.evaluate<number>("browserP0.paintProbe()").then(value => ({ value }), error => ({ error }));
  await Bun.sleep(15_000);
  const submission = await stalled as { durationMs?: number; lost?: boolean; error?: string; completed?: number; iterations?: number; errors?: string[] };
  const late = await app.main.evaluate<{ errors: string[]; lostReason: string | null }>("browserP0.evaluate('hang','window.p0GpuState')");
  const shader = { ...submission, errors: late.errors, lost: submission.lost || Boolean(late.lostReason), lostReason: late.lostReason };
  const after = await sample(app);
  const complete = shader.completed === 16384 && shader.iterations === (1_000_000_000 * 16384) % 4294967296 && !shader.errors?.length;
  const established = ((shader.durationMs || 0) >= 2000 && complete) || shader.lost === true || after.gone.length > before.gone.length;
  rows.push({ test: "gpu hang", metric: "GPU stall established", value: shader.durationMs ?? shader.error ?? null, budget: "complete GPU work >=2 s or watchdog/context loss", status: established ? "PASS" : "UNAVAILABLE" });
  const painted = await paint;
  const gaps = await frames(app);
  budget(rows, "gpu hang", "UI frame gap ms", Math.max(...gaps), 2000, "GPU/Blink compositor", "Disable agent WebGL/WebGPU, then repeat");
  if ("error" in painted) {
    rows.push({ test: "gpu hang", metric: "App pixel paint completion", value: String(painted.error), budget: "<=2000 ms", status: "FAIL", attribution: "GPU/Blink compositor; latest pixel not obtained", mitigation: "Disable agent WebGL/WebGPU" });
    await app.main.evaluate("browserP0.close('hang')");
    return { shader, paintMs: null, uiMaxGapMs: Math.max(...gaps) };
  }
  const paintMs = painted.value;
  budget(rows, "gpu hang", "App pixel paint ms", paintMs, 2000, "GPU/Blink compositor", "Disable agent WebGL/WebGPU");

  await app.main.evaluate("browserP0.close('hang')");
  return { shader, paintMs };
}

export async function mainLoad(app: P0App, origin: string, rows: Row[], tracing = true) {
  for (const path of ["nodes", "cpu", "network"]) await app.main.evaluate(`browserP0.open('${path}', '${origin}/${path}')`);
  const tracePath = join(app.dir, "load-trace.json");
  if (tracing) await app.main.evaluate("browserP0.traceStart()");
  await prepareTyping(app);
  await app.main.evaluate("browserP0.resetDelay()");
  await startFrames(app);
  const encodes: number[] = [];
  const loop = (async () => {
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      for (const id of ["nodes", "cpu", "network"]) {
        const result = await app.main.evaluate<{ jpegMs: number; jpegBytes: number }>(`browserP0.step('${id}')`);
        assert(result.jpegBytes > 0); encodes.push(result.jpegMs);
      }
    }
  })();
  const measured = await Promise.allSettled([typing(app, 60, true), loop]);
  for (const result of measured) if (result.status === "rejected") throw result.reason;
  const input = (measured[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof typing>>>).value;
  const state = await sample(app);
  if (tracing) await app.main.evaluate(`browserP0.traceStop(${JSON.stringify(tracePath)})`);
  const trace = tracing ? attributeTrace(JSON.parse(readFileSync(tracePath, "utf8")), state.uiPID, state.mainPID) : null;
  budget(rows, "load", "main loop p99 ms", state.loop.p99Ms, 30, "Electron main JS (router/encoding; trace needed)", "Frame-only webRequest; encoding off main");
  budget(rows, "load", "main loop max ms", state.loop.maxMs, 200, "Electron main JS (trace needed)", "Frame-only webRequest; encoding off main");
  budget(rows, "load", "input to paint upper bound p95 ms", input.inputToRafP95, 100, "See Chromium trace", "Trace Butler JS/Blink/GPU before choosing mitigation");
  rows.push({ test: "load", metric: "JPEG encode p95 ms", value: percentile(encodes, .95), budget: "descriptive", status: "DESCRIPTIVE" });
  for (const id of ["nodes", "cpu", "network"]) await app.main.evaluate(`browserP0.close('${id}')`);
  return { trace, jpegMaxMs: Math.max(...encodes), loop: state.loop, input };
}

export async function uiBaseline(app: P0App, rows: Row[], origin: string) {
  const scale = seedP0OwnerScale(app.data);
  await app.page.reload();
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="workspace"]')));
  await waitFor(() => app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).some(e=>e.textContent.includes('P0 대화 599'))"), "longest transcript sidebar row");
  await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).find(e=>e.textContent.includes('P0 대화 599')).click()");
  await waitFor(() => app.page.expression("document.body.textContent.includes('메시지 2999')"), "latest transcript message");
  const tracePath = join(app.dir, "baseline-trace.json");
  await app.main.evaluate("browserP0.traceStart()");
  const { session } = await app.page.expression<{ session: { id: string } }>("window.butlerApp.createSession({kind:'chat',title:'P0 streaming'})");
  await app.page.expression(`window.butlerApp.sendMessage({chatId:${JSON.stringify(session.id)},text:'스트리밍 해 주세요',clientMessageId:crypto.randomUUID(),model:'local/stub'})`);
  await waitFor(() => app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).some(e=>e.textContent.includes('P0 streaming'))"), "streaming sidebar row");
  await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).find(e=>e.textContent.includes('P0 streaming')).click()");
  await waitFor(() => app.page.expression("document.body.textContent.includes('스트리밍 응답')"), "streaming stub visible");
  const turns = () => app.page.expression<{ turns: Array<{ state: string }> }>(`window.butlerApp.listTurns({chatId:${JSON.stringify(session.id)}})`);
  assert((await turns()).turns.some(t => !["delivered", "failed", "cancelled"].includes(t.state)), "Typing must overlap active streaming Turn");
  const load = await mainLoad(app, origin, rows, false);
  const input = load.input;
  assert((await turns()).turns.some(t => !["delivered", "failed", "cancelled"].includes(t.state)), "Entire typing sample overlaps streaming");
  budget(rows, "owner scale", "Korean input to paint upper bound p95 ms", input.inputToRafP95, 100, "Trace required", "Optimize dominant JS/layout/GPU work");
  await waitFor(() => app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).some(e=>e.textContent.includes('P0 대화 599'))"), "longest transcript sidebar row");
  await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).find(e=>e.textContent.includes('P0 대화 599')).click()");
  await waitFor(() => app.page.expression("document.body.textContent.includes('메시지 2999')"), "longest transcript ready before scroll");
  await app.page.expression("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await startFrames(app);
  const scroll = await app.page.expression<{ distance: number; latest: boolean }>("new Promise(resolve=>{const e=document.querySelector('[data-test-class~=\"conversation-scroll\"]');if(!e)throw Error('Transcript scroller missing');const start=e.scrollTop;let n=0;function tick(){e.scrollTop=Math.max(0,e.scrollTop-400);if(++n<120)requestAnimationFrame(tick);else resolve({distance:Math.abs(e.scrollTop-start),latest:e.isConnected&&document.body.textContent.includes('메시지')})}requestAnimationFrame(tick)})");
  assert(scroll.distance > 0 && scroll.latest);
  const frameTimes = await frames(app);
  await app.main.evaluate(`browserP0.traceStop(${JSON.stringify(tracePath)})`);
  const attribution = attributeTrace(JSON.parse(readFileSync(tracePath, "utf8")), (await sample(app)).uiPID, (await sample(app)).mainPID);
  const metrics = (await sample(app)).metrics;
  await waitFor(async () => (await turns()).turns.some(t => t.state === "delivered"), "complete streaming Turn");
  const db = new Database(join(app.data, "app-server/butler-client.sqlite"));
  const reply = db.query("SELECT text FROM messages WHERE chat_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1").get(session.id) as { text: string };
  assert.equal(reply.text, P0_STUB_CONTENT, "Complete stub response retained");
  db.close();
  rows.push({ test: "owner scale", metric: "scroll frame p95/max ms", value: `${percentile(frameTimes, .95)}/${Math.max(...frameTimes)}`, budget: "descriptive (no scroll budget in §12)", status: "DESCRIPTIVE" });
  return { scale, load, inputSamples: input.values.length, frames: frameTimes.length, attribution, metrics };
}
