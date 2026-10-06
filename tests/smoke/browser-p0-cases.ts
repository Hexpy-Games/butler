import { quietHost } from "./browser-p0-host-load.ts";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budget, frames, percentile, sample, startFrames, typing, prepareTyping, attributeTrace, type P0App, type Row } from "./browser-p0-measure.ts";
import { seedP0OwnerScale } from "./browser-p0-owner-scale.ts";
import { waitFor, P0_STUB_CONTENT } from "./browser-p0-app.ts";

export async function rendererCrash(app: P0App, origin: string, rows: Row[]) {
  await app.main.evaluate(`browserP0.open('crash', '${origin}/nodes')`);
  const before = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
  await quietHost("renderer crash", app);
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
  const user = process.env.BUTLER_P0_GPU_SOURCE === "user";
  await app.main.evaluate(user ? `browserP0.openProductGPU('gpu', '${origin}/gpu')` : `browserP0.open('gpu', '${origin}/gpu')`);
  const before = await sample(app);
  const policy = await app.main.evaluate<{ webgl: boolean; webgl2: boolean; webgpu: boolean }>("browserP0.gpuPolicy('gpu')");
  const webgpu = policy.webgpu;
  if (user) assert(policy.webgl && policy.webgl2 && policy.webgpu, "User tab retains GPU APIs");
  if (!user && process.env.BUTLER_P0_AGENT_GPU === "off") {
    for (const feature of ["webgl", "webgl2", "webgpu"] as const) rows.push({ test: "gpu crash", metric: `agent ${feature} disabled`, value: String(policy[feature]), budget: "false", status: policy[feature] ? "FAIL" : "PASS", attribution: "Electron per-view capability policy", mitigation: "Verify a supported per-view GPU policy before treating this as a mitigation run" });
  }
  const evidence = process.env.BUTLER_P0_EVIDENCE;
  assert(evidence, "BUTLER_P0_EVIDENCE required"); mkdirSync(evidence, { recursive: true });
  await app.page.expression("(()=>{window.p0WallpaperContexts=[];for(const c of document.querySelectorAll('canvas[data-module]'))for(const name of ['webglcontextlost','webglcontextrestored'])c.addEventListener(name,()=>window.p0WallpaperContexts.push({name,at:performance.now()}))})()");
  writeFileSync(join(evidence, `${user ? "user" : "agent"}-before.png`), await app.page.screenshot());
  await startFrames(app);
  await app.page.expression("(()=>{window.p0WallpaperDraws=0;const p=WebGL2RenderingContext.prototype,draw=p.drawArrays;p.drawArrays=function(...args){window.p0WallpaperDraws++;return draw.apply(this,args)}})()");
  await Bun.sleep(1000);
  assert(await app.page.expression<number>("window.p0WallpaperDraws") > 0, "Animated Butler wallpaper must be drawing");
  const gaps: number[] = [], lossEvidence: unknown[] = [];
  let firstLoss = 0, lastLoss = 0;
  // Loss storms do not reliably crash the process; chrome://gpucrash makes
  // each process loss deterministic while keeping the fixture workload.
  for (let i = 0; i < 5; i++) {
    if (i) await Bun.sleep(Math.max(0, firstLoss + i * 120_000 - performance.now()));
    const count = (await sample(app)).gone.filter(p => p.type === "GPU").length;
    const hostLoad = await quietHost(`GPU loss ${i + 1} ${user ? "user" : "agent"}`, app);
    await startFrames(app);
    const lossAt = performance.now();
    if (!firstLoss) firstLoss = lossAt; lastLoss = lossAt;
    await app.main.evaluate("browserP0.loseGPU('gpu')");
    await waitFor(async () => (await sample(app)).gone.filter(p => p.type === "GPU").length > count, "GPU process loss");
    const painted = await app.main.evaluate("browserP0.paintProbe()").then(() => true as const, error => String(error));
    if (painted === true) budget(rows, "gpu crash", `UI pixel recovery loss ${i + 1} ms`, performance.now() - lossAt, 2000, "GPU/Blink compositor", "Disable agent WebGL/WebGPU");
    else rows.push({ test: "gpu crash", metric: `UI pixel recovery loss ${i + 1}`, value: painted, budget: "latest pixel painted <=2000 ms", status: "FAIL", attribution: "GPU/Blink compositor", mitigation: "Disable agent WebGL/WebGPU" });
    const userBefore = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
    const wallpaperBefore = await app.page.expression<number>("window.p0WallpaperDraws");
    const wallpaperPixelsBefore = await app.main.evaluate<string>("browserP0.wallpaperFrame()");
    await Bun.sleep(2000);
    const navigation = await app.main.evaluate<{ blocked?: boolean }>(`browserP0.navigate('gpu', '${origin}/gpu')`);
    if (user && i === 4) {
      const validWindow = lossAt - firstLoss <= 600_000;
      if (validWindow) assert(navigation.blocked && await app.main.evaluate("browserP0.productBlocked()"), "Real USER Browser breaker trips at five losses");
      rows.push({ test: "gpu crash", metric: "USER five-loss breaker", value: validWindow ? "blocked" : "invalid trigger window", budget: "blocked within five losses / 10 min", status: validWindow ? "PASS" : "UNAVAILABLE" });
    }
    const state = await sample(app);
    const wallpaperAfter = await app.page.expression<number>("window.p0WallpaperDraws");
    const wallpaperPixelsAfter = await app.main.evaluate<string>("browserP0.wallpaperFrame()");
    rows.push({ test: "gpu crash", metric: `wallpaper pixels changed loss ${i + 1}`, value: String(wallpaperPixelsBefore !== wallpaperPixelsAfter), budget: "true", status: wallpaperPixelsBefore !== wallpaperPixelsAfter ? "PASS" : "FAIL" });
    const userAfter = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
    rows.push({ test: "gpu crash", metric: `wallpaper resumed loss ${i + 1}`, value: wallpaperAfter - wallpaperBefore, budget: ">0 draw calls", status: wallpaperAfter > wallpaperBefore ? "PASS" : "FAIL", attribution: "Butler wallpaper WebGL context after GPU loss", mitigation: "Disable agent WebGL/WebGPU; verify context restoration" });
    rows.push({ test: "gpu crash", metric: `user video resumed loss ${i + 1}`, value: userAfter - userBefore, budget: ">0 decoded frames", status: userAfter > userBefore ? "PASS" : "FAIL", attribution: "GPU/Blink video recovery", mitigation: "Disable agent WebGL/WebGPU" });
    rows.push({ test: "gpu crash", metric: `GPU feature status loss ${i + 1}`, value: JSON.stringify(state.gpu), budget: JSON.stringify(before.gpu), status: JSON.stringify(state.gpu) === JSON.stringify(before.gpu) ? "PASS" : "FAIL", attribution: "GPU", mitigation: "Disable agent WebGL/WebGPU, then repeat" });
    gaps.push(...await frames(app));
    const loss = { gpuLoss: i + 1, hostLoad, gpuStatus: state.gpu, wallpaperPixelsBefore, wallpaperPixelsAfter, wallpaperDraws: wallpaperAfter - wallpaperBefore, userFrames: userAfter - userBefore, featuresUnchanged: JSON.stringify(state.gpu) === JSON.stringify(before.gpu) };
    const contexts = await app.page.expression("window.p0WallpaperContexts");
    writeFileSync(join(evidence, `${user ? "user" : "agent"}-loss-${i + 1}.png`), await app.page.screenshot());
    lossEvidence.push({ ...loss, contexts }); console.log(JSON.stringify({ ...loss, contexts }));
  }
  // Observe the full ten-minute interval; busy admission cannot relax its limit.
  await Bun.sleep(Math.max(0, firstLoss + 600_000 - performance.now()));
  const observationMs = performance.now() - firstLoss;
  const after = await sample(app);
  budget(rows, "gpu crash", "UI frame gap ms", Math.max(...gaps), 2000, "GPU", "Disable agent WebGL/WebGPU");
  assert.equal(after.gone.filter(p => p.type === "GPU").length - before.gone.filter(p => p.type === "GPU").length, 5);
  await app.main.evaluate("browserP0.close('gpu')");
  budget(rows, "gpu crash", "five-loss window ms", lastLoss - firstLoss, 600_000, "Host contention may delay admission", "Wait for a quiet host");
  return { source: user ? "P2a-1 USER via renderer IPC" : "agent-tab harness", policy, webgpu, observationMs, lossEvidence, losses: after.gone.filter(p=>p.type==="GPU"), uiMaxGapMs: Math.max(...gaps) };
}

export async function gpuHang(app: P0App, origin: string, rows: Row[]) {
  const user = process.env.BUTLER_P0_GPU_SOURCE === "user";
  await app.main.evaluate(`browserP0.open('hang', '${origin}/hang', {user:${user}})`);
  const policy = await app.main.evaluate("browserP0.gpuPolicy('hang')");
  await quietHost("GPU calibration", app);
  const prepared = await app.main.evaluate<{ blocked: boolean }>("browserP0.evaluate('hang','prepare()')");
  const hostLoad = await quietHost(`GPU hang ${user ? "user" : "agent"}`, app);
  const before = await sample(app);
  await startFrames(app);
  const stalled = prepared.blocked ? Promise.resolve({ blocked: true }) : app.main.evaluate("browserP0.evaluate('hang','stall()')").catch(error => ({ error: String(error) }));
  await Bun.sleep(100);
  const paint = app.main.evaluate<number>("browserP0.paintProbe()").then(value => ({ value }), error => ({ error: String(error) }));
  await Bun.sleep(15_000);
  const shader = await stalled as { blocked?: boolean; gpuMs?: number; fenceMs?: number; correct?: boolean; error?: string; errors?: string[]; lostReason?: string };
  const after = await sample(app);
  const established = !!shader.correct && (shader.gpuMs || 0) >= 2000 && !shader.errors?.length;
  rows.push({ test: "gpu hang", metric: "GPU stall established", value: JSON.stringify(shader), budget: "verified result and GPU timestamp >=2000 ms", status: shader.blocked ? "PASS" : established ? "PASS" : "UNAVAILABLE" });
  const painted = await paint, gaps = await frames(app);
  budget(rows, "gpu hang", "UI frame gap ms", Math.max(...gaps), 2000, "Shared GPU/Blink compositor", "Agent GPU policy cannot protect user tabs");
  if ("error" in painted) rows.push({ test: "gpu hang", metric: "App pixel paint completion", value: painted.error, budget: "<=2000 ms", status: "FAIL" });
  else budget(rows, "gpu hang", "App pixel paint ms", painted.value, 2000, "Shared GPU/Blink compositor", "Separate browser process tree");
  await app.main.evaluate("browserP0.close('hang')");
  return { shader, prepared, policy, hostLoad, painted, uiMaxGapMs: Math.max(...gaps), gpuProcessLosses: after.gone.length - before.gone.length, watchdog: app.watchdogEvidence() };
}

export async function mainLoad(app: P0App, origin: string, rows: Row[], tracing = true, beforeMeasure?: () => Promise<void>) {
  for (const path of ["nodes", "cpu", "network"]) await app.main.evaluate(`browserP0.open('${path}', '${origin}/${path}')`);
  const tracePath = join(app.dir, "load-trace.json");
  const hostLoad = await quietHost("main load", app);
  if (beforeMeasure) await beforeMeasure();
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
  rows.push({ test: "load", metric: "ThreadPool JPEG encode p95 ms", value: trace?.jpegEncoding?.p95Ms ?? null, budget: "descriptive", status: trace?.jpegEncoding ? "DESCRIPTIVE" : tracing ? "UNAVAILABLE" : "DESCRIPTIVE" });
  rows.push({ test: "load", metric: "Chromium capture+JPEG+IPC p95 ms", value: percentile(encodes, .95), budget: "descriptive", status: "DESCRIPTIVE" });
  for (const id of ["nodes", "cpu", "network"]) await app.main.evaluate(`browserP0.close('${id}')`);
  return { trace, hostLoad, jpegMaxMs: Math.max(...encodes), loop: state.loop, input };
}

export async function uiBaseline(app: P0App, rows: Row[], origin: string) {
  const scale = seedP0OwnerScale(app.data);
  await app.page.reload();
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="workspace"]')));
  await waitFor(() => app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).some(e=>e.textContent.includes('P0 대화 599'))"), "longest transcript sidebar row");
  await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).find(e=>e.textContent.includes('P0 대화 599')).click()");
  await waitFor(() => app.page.expression("document.body.textContent.includes('메시지 2999')"), "latest transcript message");
  const tracePath = join(app.dir, "baseline-trace.json");
  const { session } = await app.page.expression<{ session: { id: string } }>("window.butlerApp.createSession({kind:'chat',title:'P0 streaming'})");
  await waitFor(() => app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).some(e=>e.textContent.includes('P0 streaming'))"), "streaming sidebar row");
  await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).find(e=>e.textContent.includes('P0 streaming')).click()");
  const turns = () => app.page.expression<{ turns: Array<{ state: string }> }>(`window.butlerApp.listTurns({chatId:${JSON.stringify(session.id)}})`);
  const load = await mainLoad(app, origin, rows, false, async () => {
    await app.main.evaluate("browserP0.traceStart()");
    await app.page.expression(`window.butlerApp.sendMessage({chatId:${JSON.stringify(session.id)},text:'스트리밍 해 주세요',clientMessageId:crypto.randomUUID(),model:'local/stub'})`);
    await waitFor(() => app.page.expression("document.body.textContent.includes('스트리밍 응답')"), "streaming stub visible");
    assert((await turns()).turns.some(t => !["delivered", "failed", "cancelled"].includes(t.state)), "Typing must overlap active streaming Turn");
  });
  const input = load.input;
  await app.main.evaluate(`browserP0.traceStop(${JSON.stringify(tracePath)})`);
  const loadAttribution = attributeTrace(JSON.parse(readFileSync(tracePath, "utf8")), (await sample(app)).uiPID, (await sample(app)).mainPID);
  rows.push({ test: "owner scale", metric: "ThreadPool JPEG encode p95 ms", value: loadAttribution.jpegEncoding?.p95Ms ?? null, budget: "descriptive", status: loadAttribution.jpegEncoding ? "DESCRIPTIVE" : "UNAVAILABLE" });
  assert((await turns()).turns.some(t => !["delivered", "failed", "cancelled"].includes(t.state)), "Entire typing sample overlaps streaming");
  budget(rows, "owner scale", "Korean input to paint upper bound p95 ms", input.inputToRafP95, 100, "Trace required", "Optimize dominant JS/layout/GPU work");
  await waitFor(() => app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).some(e=>e.textContent.includes('P0 대화 599'))"), "longest transcript sidebar row");
  await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).find(e=>e.textContent.includes('P0 대화 599')).click()");
  await waitFor(() => app.page.expression("document.body.textContent.includes('메시지 2999')"), "longest transcript ready before scroll");
  await app.page.expression("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const scrollHostLoad = await quietHost("owner-scale scroll", app);
  await app.main.evaluate("browserP0.traceStart()");
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
  return { scale, load, inputSamples: input.values.length, frames: frameTimes.length, attribution, loadAttribution, scrollHostLoad, metrics };
}
