// test-category: security
import { strict as assert } from "node:assert";
import { redesignApp } from "../support/browser-redesign-app";
import { bridgeBrowser, describeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence);
const app = await redesignApp(evidence);
const stream = new AbortController();
const legacyStream = new AbortController();
try {
  console.log(`Electron PID ${await app.main<number>("process.pid")}`);
  let tab = "", modelMessages = "";
  app.stub.set([
    describeBrowser,
    () => bridgeBrowser("browser_open", { url: app.url }),
    request => {
      tab = latestBrowser(request, "tab").tab as string;
      return bridgeBrowser("browser_wait_for_user", { tab, reason: "sign_in" });
    },
    () => bridgeBrowser("browser_observe", { tab }),
    request => { modelMessages = JSON.stringify(request.messages); return null; },
  ]);
  await app.send("Open the fixture, wait for my input, then observe it.");
  let requestRef = "";
  await waitBrowser(async () => {
    const { requests } = await app.gateway.api<{ requests: { executable: string; request_ref: string }[] }>("/authority-requests?session_id=general");
    requestRef = requests.find(request => request.executable === "browser_wait_for_user")?.request_ref ?? "";
    return Boolean(requestRef);
  }, "browser hand-off request");
  const browser = "globalThis.browserAgentSubject";
  const subject = `${browser}.tabs.get(${JSON.stringify(tab)})`;
  assert.equal(await app.main(`${subject}.attached===${browser}.agentWindow && !${browser}.agentWindow.isVisible()`), true);
  const before = await app.main<number>(`${subject}.view.webContents.executeJavaScript("innerWidth")`);
  assert.equal(before, 1280);
  await app.main(`${subject}.view.webContents.executeJavaScript(${JSON.stringify(
    `document.head.insertAdjacentHTML("beforeend", '<meta name="viewport" content="width=device-width">')`,
  )})`);
  const path = `/browser/tabs/${encodeURIComponent(tab)}/live`;
  const client = crypto.randomUUID();
  const post = (seq: number, events: unknown[]) => app.gateway.api(`${path}/input`, {
    method: "POST", body: JSON.stringify({ client, seq, events }), signal: AbortSignal.timeout(5000),
  });
  async function* records(response: Promise<Response>) {
    const reply = await response;
    assert.equal(reply.status, 200, "live stream opens");
    assert.ok(reply.body);
    const body = reply.body.getReader();
    let pending = Buffer.alloc(0);
    for (;;) {
      const { done, value } = await body.read();
      if (done) return;
      pending = Buffer.concat([pending, value]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (pending.length < 5 + length) break;
        yield { type: pending[0], payload: pending.subarray(5, 5 + length) };
        pending = pending.subarray(5 + length);
      }
    }
  }
  const legacyReader = records(fetch(new URL(`${path}?width=720`, app.gateway.url), {
    headers: { ...app.gateway.authHeaders, accept: "application/vnd.butler.browser-live" },
    signal: AbortSignal.any([legacyStream.signal, AbortSignal.timeout(30_000)]),
  }));
  for (;;) {
    const next = await legacyReader.next();
    assert.ok(!next.done, "width-only stream ended before its first frame");
    if (next.value.type !== 2) continue;
    assert.ok(next.value.payload[0] === 0xff && next.value.payload[1] === 0xd8, "width-only JPEG frame");
    break;
  }
  assert.equal(await app.main<number>(`${subject}.view.webContents.executeJavaScript("innerWidth")`), before);
  assert.equal(await app.main(`${subject}.phoneViewport ?? null`), null);
  legacyStream.abort();
  await waitBrowser(async () => await app.main<boolean>(`!${browser}.phoneLive.feeds.has(${subject}.id)`), "width-only stream stopped");
  const started = performance.now();
  const response = fetch(new URL(`${path}?width=390&height=844&dpr=2`, app.gateway.url), {
    headers: { ...app.gateway.authHeaders, accept: "application/vnd.butler.browser-live" },
    signal: AbortSignal.any([stream.signal, AbortSignal.timeout(30_000)]),
  });
  const reader = records(response);
  const firstFrame = (async () => {
    let meta: { width: number; height: number } | undefined;
    for (;;) {
      const next = await reader.next();
      assert.ok(!next.done, "stream ended before its first frame");
      if (next.value.type === 1) meta ??= JSON.parse(next.value.payload.toString());
      if (next.value.type === 2) {
        assert.ok(meta, "first frame has metadata");
        assert.ok(Math.abs(meta.width / meta.height - 390 / 844) < 0.01, `frame dimensions ${meta.width}×${meta.height}`);
        return next.value.payload;
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, 5000 - (performance.now() - started))); });
  const frame = await Promise.race([firstFrame, deadline]).finally(() => clearTimeout(timer));
  assert.ok(frame && frame[0] === 0xff && frame[1] === 0xd8, "JPEG frame within 5 s");
  assert.deepEqual(await app.main(`${subject}.view.webContents.executeJavaScript("[innerWidth, screen.width, devicePixelRatio]")`), [390, 390, 2]);
  const point = await app.main<{ x: number; y: number }>(`${subject}.view.webContents.executeJavaScript(
    "(()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:(r.x+r.width/2)/innerWidth,y:(r.y+r.height/2)/innerHeight}})()")`);
  await post(1, [{ t: "down", ...point }, { t: "up", ...point }]);
  await post(2, [{ t: "text", value: "typed-7311" }]);
  assert.equal(await app.main(`${subject}.view.webContents.executeJavaScript("document.querySelector('input').value")`), "typed-7311");
  const page = (code: string) => app.main<unknown>(`${subject}.view.webContents.executeJavaScript(${JSON.stringify(code)})`);
  const below = await page(`document.body.insertAdjacentHTML("afterbegin", '<div style="height:500px"></div>');
    document.body.insertAdjacentHTML("beforeend", '<div style="height:1200px"></div>');
    scrollTo(0, 0); const input = document.querySelector("input"); input.focus(); input.getBoundingClientRect().bottom`) as number;
  assert.ok(below > 400, `focused field bottom ${below} px lies under a 400 px keyboard viewport`);
  await post(3, [{ t: "viewport", width: 390, height: 400, dpr: 2 }]);
  await waitBrowser(async () => await page(`(() => { const input = document.querySelector("input"), r = input.getBoundingClientRect();
    return innerWidth === 390 && innerHeight === 400 && document.activeElement === input && r.top >= 0 && r.bottom <= innerHeight; })()`) === true,
    "focused field revealed above the keyboard");
  assert.deepEqual(await app.main(`${browser}.snapshot().tabs.find(item => item.id === ${JSON.stringify(tab)}).phoneViewport`), { width: 390, height: 400 });
  await post(4, [{ t: "viewport", width: 844, height: 390, dpr: 2 }]);
  await waitBrowser(async () => await app.main<number>(`${subject}.view.webContents.executeJavaScript("innerWidth")`) === 844, "rotated viewport");
  await app.gateway.api(`/authority-requests/${encodeURIComponent(requestRef)}/hand-back?session_id=general`, { method: "POST", body: "{}" });
  for (;;) {
    const next = await reader.next();
    assert.ok(!next.done, "stream closed without an end record");
    if (next.value.type !== 4) continue;
    assert.equal(JSON.parse(next.value.payload.toString()).reason, "handed_back");
    assert.deepEqual(await app.main(`${subject}.view.webContents.executeJavaScript("[innerWidth, screen.width, devicePixelRatio]")`), [before, 1280, 1]);
    assert.deepEqual(await app.main(`${subject}.view.getBounds()`), { x: 0, y: 0, width: 1280, height: 800 });
    await waitBrowser(async () => await app.main(`${browser}.snapshot().tabs.find(item => item.id === ${JSON.stringify(tab)}).phoneViewport ?? null`) === null, "desktop page size published again");
    assert.equal((await reader.next()).done, true);
    break;
  }
  await app.delivered();
  assert.doesNotMatch(modelMessages, /typed-7311/u);
  assert.match(modelMessages, /entered by user \(hidden\)/u);
} finally {
  legacyStream.abort();
  stream.abort();
  await app.stop();
}
