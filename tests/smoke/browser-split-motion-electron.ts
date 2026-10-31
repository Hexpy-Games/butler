// test-category: race
/**
 * The right pane moving with a running native browser tab, in the real App (#1585 covers the capture hang itself).
 * The native view cannot follow a CSS transform, so a still stands in while the pane moves. Reads every frame the App's
 * renderer paints, with where the native view was at that moment: the page area shows the page itself or a still of
 * it, never an empty card; the view is never on screen while the pane travels; the painted gap between the chat and the
 * pane stays at rest, also with a busy main thread; the title group ends with the chat; the view ends on its slot;
 * captures still settle; a reload with the pane open does not move.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, pane, shellReady, togglePane, toggle } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
// A running page: it keeps painting.
const fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(
  "<!doctype html><title>Running page</title><style>html,body{margin:0;height:100%;background:#365bf5;color:#fff;font:14px system-ui}</style><p id=n>0</p><script>let n=0;setInterval(()=>{document.getElementById('n').textContent=++n},50)</script>",
  { headers: { "content-type": "text/html" } }) });
const para = "브라우저를 옆에 열어 두고 대화를 이어 갈 때 문단이 줄바꿈을 다시 하게 됩니다. This sentence is long enough to wrap several times at either width.";
const app = await browserAgentApp(evidence, () => null, undefined, { stubReply: () => `## 검토\n\n${para}\n\n- ${para}\n\n${para}` });

type PaintedFrame = { t: number; visible: number; seenVisible: number; page: number; green: number; onScreen: boolean; gap: number | null; viewX?: number; slotX?: number };
type MotionRun = { frames: PaintedFrame[]; dom: { longest: number; frames: number; moved: number | null; end: number | null; maxDist: number; edges: number[][] } };

/** Installs the frame reader in the main process: per painted frame, how much of the page area shows the page's colour. */
async function installFrameReader(id: string) {
  await app.main(`(() => {
    const b = globalThis.browserAgentSubject, t = b.tabs.get(${JSON.stringify(id)}), w = ${app.win};
    let frames = [], previous;
    w.webContents.beginFrameSubscription(false, (image) => {
        const size = image.getSize(), width = w.getContentBounds().width, scale = size.width / width, slot = t.slot, seen = previous;
        previous = slot?.x;
        const entry = { t: Date.now(), visible: 0, seenVisible: 0, gap: null, page: 0, green: 0, onScreen: t.attached === w && t.view.getVisible(), viewX: t.view?.getBounds().x, slotX: slot?.x };
        if (slot?.visible) {
          // A painted frame may be one step behind the slot: read only what was already in place a frame ago.
          const left = Math.max(0, slot.x, seen ?? 0), right = Math.min(width, slot.x + slot.width);
          entry.visible = Math.max(0, right - left);
          entry.seenVisible = Math.max(0, right - Math.max(left, seen ?? width));
          // The gap as painted: the first run of the shell's colour across one row, after the sidebar.
          const shell = image.crop({ x: Math.round(500 * scale), y: Math.round(6 * scale), width: 1, height: 1 }).toBitmap();
          const row = image.crop({ x: 0, y: Math.round(500 * scale), width: size.width, height: 1 }).toBitmap();
          const near = (x) => [0, 1, 2].every((c) => Math.abs(row[x * 4 + c] - shell[c]) <= 3);
          for (let x = Math.round(330 * scale), from = -1; x < size.width - scale; x++) {
            if (near(x)) { if (from < 0) from = x; } else if (from >= 0) { if (x - from >= 2) { entry.gap = (x - from) / scale; break; } from = -1; }
          }
          if (entry.visible > 24) {
            const bitmap = image.crop({ x: Math.round((left + 4) * scale), y: Math.round((slot.y + slot.height * 0.25) * scale), width: Math.round((right - left - 8) * scale), height: Math.round(slot.height * 0.5 * scale) }).toBitmap();
            let page = 0, green = 0, n = 0;
            for (let i = 0; i < bitmap.length; i += 4 * 29) { n++; if (bitmap[i] > 180 && bitmap[i + 1] < 150 && bitmap[i + 2] < 120) page++; if (bitmap[i] < 130 && bitmap[i + 1] > 150 && bitmap[i + 2] < 130) green++; }
            entry.page = page / n; entry.green = green / n;
          }
        }
        frames.push(entry);
    });
    globalThis.__splitFrames = { start() { frames = []; }, stop() { return frames; } };
  })()`);
}

/** Clicks the toggle, with every animation frame sampled in the renderer and every painted frame read in main. */
async function toggleWatched(): Promise<MotionRun> {
  await app.main("globalThis.__splitFrames.start()");
  const dom = await app.page.expression<MotionRun["dom"]>(`new Promise((resolve) => {
    const edges = [], box = (s) => document.querySelector(s)?.getBoundingClientRect().right;
    const start = performance.now(), chat = () => document.querySelector('[data-slot="adaptive-shell-split-chat"]'), scroll = () => document.querySelector('[data-test-class~="conversation-scroll"]');
    const pane = () => document.querySelector('[data-slot="adaptive-shell-split-pane"]');
    let last = start, longest = 0, frames = 0, moved = null, end = null, maxDist = 0;
    const running = () => pane()?.getAnimations().some((a) => a.playState === 'running') ?? false;
    const tick = (now) => {
      longest = Math.max(longest, now - last); last = now; frames++;
      const s = scroll(); if (s) maxDist = Math.max(maxDist, s.scrollHeight - s.scrollTop - s.clientHeight);
      edges.push([box('[data-slot="adaptive-shell-split-chat"]'), box('[data-slot="titlebar-chat-group"]')]);
      if (moved === null && running()) moved = Math.round(now - start);
      if (moved !== null && end === null && !running()) end = Math.round(now - start);
      if (now - start < 800) requestAnimationFrame(tick); else resolve({ longest: Math.round(longest), frames, moved, end, maxDist: Math.round(maxDist), edges });
    };
    requestAnimationFrame(tick);
    document.querySelector(${JSON.stringify(toggle)}).click();
  })`);
  return { frames: await app.main<PaintedFrame[]>("globalThis.__splitFrames.stop()"), dom };
}

/** While the page area is on screen and the native view is not, the frame must show a still of the page. */
function blankFrames(run: MotionRun, painted: "page" | "green" = "page") {
  return run.frames.filter((frame) => frame.visible > 24 && !frame.onScreen && frame[painted] < 0.5);
}

/** While the pane travels the native view stays off screen, the painted gap holds and the title group ends with the chat. */
function assertTogether(run: MotionRun, label: string, restGap: number, restX: number) {
  const seenOnPage = run.frames.filter((frame) => frame.visible > 24 && frame.onScreen && Math.abs((frame.slotX ?? restX) - restX) > 1);
  assert.deepEqual(seenOnPage, [], `${label}: the native view is off screen while the pane travels`);
  const apart = run.frames.filter((frame) => frame.seenVisible > 24 && (frame.gap === null || Math.abs(frame.gap - restGap) > 1.5));
  assert.deepEqual(apart.map((frame) => [frame.slotX, frame.gap]), [], `${label}: the painted gap stays at ${restGap}`);
  const [from, to] = [run.dom.edges[0]!, run.dom.edges.at(-1)!];
  for (const [chat, title] of run.dom.edges as number[][]) {
    const expected = from[1]! + (chat! - from[0]!) / (to[0]! - from[0]!) * (to[1]! - from[1]!);
    assert(Math.abs(title! - expected) <= 2, `${label}: the title group ends with the chat (${title} against ${Math.round(expected)})`);
  }
}

function assertNoBlank(run: MotionRun, label: string, painted: "page" | "green" = "page") {
  const blank = blankFrames(run, painted);
  assert.equal(blank.length, 0, `${label}: the page area shows the page or a still of it: ${JSON.stringify({ blank, frames: run.frames.length, dom: run.dom, all: run.frames.map((f) => [f.t - run.frames[0]!.t, f.visible, +f.page.toFixed(2), +f.green.toFixed(2), f.onScreen, f.slotX]) })}`);
}

const facts: Record<string, unknown> = {};
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light", reduce_motion: false }) });
  await app.page.reload(); await shellReady(app, "en");
  await app.click(getAppCopy("en-US").space.general);
  for (let turn = 0; turn < 8; turn++) {
    await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: `${turn}: ${para}`, client_message_id: crypto.randomUUID() }) });
    await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === "delivered", "stub turn delivered");
  }
  await app.call("open");
  const id = await app.call<string>("create", { owner: "conversation:general", url: fixture.url.href });
  await app.call("activate", { id });
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${toggle}'))`), "browser toggle");
  // From before the page first shows: a subscribed window draws even when another window covers it.
  await installFrameReader(id);
  if (!await app.page.expression<boolean>(`Boolean(document.querySelector('${pane}'))`)) await togglePane(app, true);
  await nativeAligned(app);

  const rest = await app.main<{ x: number }>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).slot`);
  const restGap = await app.page.expression<number>("document.querySelector('[data-slot=adaptive-shell-split-pane]').getBoundingClientRect().left - document.querySelector('[data-slot=adaptive-shell-split-chat]').getBoundingClientRect().right");

  // Close and open again, several rounds: the page shows or a still of it does, and the view lands on its slot.
  for (let round = 0; round < 4; round++) {
    const close = await toggleWatched();
    assertNoBlank(close, `round ${round} close`);
    assertTogether(close, `round ${round} close`, restGap, rest.x);
    assert(close.dom.moved !== null, `round ${round}: the pane moves when closing`);
    await waitBrowser(() => app.page.expression(`!document.querySelector('${pane}')`), "pane closed");
    const open = await toggleWatched();
    assertNoBlank(open, `round ${round} open`);
    assertTogether(open, `round ${round} open`, restGap, rest.x);
    assert(open.dom.moved !== null, `round ${round}: the pane moves when opening`);
    await nativeAligned(app);
    assert.equal(open.dom.maxDist, 0, `round ${round}: the bottom-pinned transcript stays at the bottom`);
    const brief = (run: MotionRun) => { const { edges: _edges, ...rest } = run.dom; return { ...rest, painted: run.frames.length, gaps: [...new Set(run.frames.filter((frame) => frame.seenVisible > 24).map((frame) => frame.gap))] }; };
    facts[`round${round}`] = { close: brief(close), open: brief(open) };
  }

  // A main thread busy for most of each frame: the chat and the pane still paint together.
  await app.page.expression("(() => { window.__busy = true; const busy = () => { if (!window.__busy) return; const end = performance.now() + 25; while (performance.now() < end); requestAnimationFrame(busy); }; requestAnimationFrame(busy); return 1; })()");
  const busyClose = await toggleWatched();
  assertTogether(busyClose, "busy close", restGap, rest.x);
  await waitBrowser(() => app.page.expression(`!document.querySelector('${pane}')`), "pane closed");
  const busyOpen = await toggleWatched();
  assertTogether(busyOpen, "busy open", restGap, rest.x);
  await app.page.expression("(() => { window.__busy = false; return 1; })()");
  await nativeAligned(app);
  facts.busy = { close: { moved: busyClose.dom.moved, painted: busyClose.frames.length }, open: { moved: busyOpen.dom.moved, painted: busyOpen.frames.length } };

  // A tab Butler drives keeps working parked in the hidden window: the pane opens on its latest page.
  await togglePane(app, false);
  await app.main(`(() => { const t = globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}); t.driven = true; globalThis.browserAgentSubject.sync(t); })()`);
  await waitBrowser(() => app.main<boolean>(`(() => { const t = globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}); return Boolean(t.attached) && t.attached !== ${app.win} && !t.attachWait && !t.detachWait; })()`), "the driven tab parks in the hidden window");
  await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents.executeJavaScript("document.documentElement.style.background=document.body.style.background='#22c55e';new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))")`);
  const driven = await toggleWatched();
  assertNoBlank(driven, "driven open", "green");
  await nativeAligned(app);
  facts.driven = { moved: driven.dom.moved, end: driven.dom.end, longest: driven.dom.longest, painted: driven.frames.length };
  await app.main(`(() => { const t = globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}); t.driven = false; globalThis.browserAgentSubject.sync(t); })()`);
  await nativeAligned(app);

  // Rapid toggling while captures run: the last state wins, the view ends on its slot and later captures settle.
  await app.page.expression(`(async () => { const button = document.querySelector(${JSON.stringify(toggle)}); for (let i = 0; i < 7; i++) { button.click(); await new Promise((done) => setTimeout(done, 40 + i * 15)); } })()`);
  await waitBrowser(() => app.page.expression(`!document.querySelector('[data-slot="adaptive-shell-split"][data-pane-leaving]') && document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-pressed') === 'false' && !document.querySelector('${pane}')`), "rapid toggling ends closed");
  await togglePane(app, true);
  await nativeAligned(app);
  const settled = await app.main<{ still: number; page: number; bounds: Record<string, number>; slot: Record<string, number> }>(`(async () => {
    const b = globalThis.browserAgentSubject, t = b.tabs.get(${JSON.stringify(id)}), hang = (p, label) => Promise.race([p, new Promise((_, fail) => setTimeout(() => fail(new Error(label + ' never settled')), 10000))]);
    const s0 = Date.now(); await hang(b.capture(t), 'still'); const s1 = Date.now(); await hang(t.view.webContents.capturePage(undefined, { stayHidden: true }), 'page capture'); const s2 = Date.now();
    return { still: s1 - s0, page: s2 - s1, bounds: t.view.getBounds(), slot: t.slot };
  })()`);
  for (const key of ["x", "y", "width", "height"]) assert(Math.abs(settled.bounds[key]! - settled.slot[key]!) <= 1, `the view ends on its slot: ${JSON.stringify(settled)}`);
  facts.settled = settled;

  // A reload with the pane open comes back in place: no motion from the first frame on.
  const targets = await (await fetch(`http://127.0.0.1:${app.debug}/json`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.url.startsWith("app://butler/"))!.webSocketDebuggerUrl);
  await new Promise((done) => { socket.onopen = done; });
  const replied = new Promise((done) => { socket.onmessage = (event) => { if (JSON.parse(String(event.data)).id === 2) done(true); }; });
  socket.send(JSON.stringify({ id: 1, method: "Page.enable" }));
  socket.send(JSON.stringify({ id: 2, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: `window.__splitRestore=[];(()=>{const tick=()=>{for(const n of document.querySelectorAll('[data-slot="adaptive-shell-split-chat"],[data-slot="adaptive-shell-split-pane"]'))if(n.getAnimations().some(a=>a.playState==='running'))window.__splitRestore.push(Math.round(performance.now()));requestAnimationFrame(tick)};requestAnimationFrame(tick)})()` } }));
  await replied;
  await app.page.reload();
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${pane}'))`), "pane restored");
  await nativeAligned(app);
  assert.deepEqual(await app.page.expression("window.__splitRestore"), [], "a reload with the pane open does not animate");
  socket.close();
  writeFileSync(join(evidence, "split-motion.json"), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts));
  await app.main(`${app.win}.webContents.endFrameSubscription()`);
} finally { fixture.stop(true); await app.stop(); }
