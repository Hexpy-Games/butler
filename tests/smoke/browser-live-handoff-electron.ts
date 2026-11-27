// test-category: security
import { strict as assert } from "node:assert";
import { redesignApp } from "../support/browser-redesign-app";
import { bridgeBrowser, describeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence);
const app = await redesignApp(evidence);
const stream = new AbortController();
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
  const point = await app.main<{ x: number; y: number }>(`${subject}.view.webContents.executeJavaScript(
    "(()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:(r.x+r.width/2)/innerWidth,y:(r.y+r.height/2)/innerHeight}})()")`);
  const path = `/browser/tabs/${encodeURIComponent(tab)}/live`;
  const client = crypto.randomUUID();
  const tap = [{ t: "down", ...point }, { t: "up", ...point }];
  const post = (seq: number, events: unknown[]) => app.gateway.api(`${path}/input`, {
    method: "POST", body: JSON.stringify({ client, seq, events }), signal: AbortSignal.timeout(5000),
  });
  const started = performance.now();
  const response = fetch(new URL(path, app.gateway.url), {
    headers: { ...app.gateway.authHeaders, accept: "application/vnd.butler.browser-live" },
    signal: AbortSignal.any([stream.signal, AbortSignal.timeout(30_000)]),
  });
  async function* records() {
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
  const reader = records();
  const firstFrame = (async () => {
    for (;;) {
      const next = await reader.next();
      assert.ok(!next.done, "stream ended before its first frame");
      if (next.value.type === 2) return next.value.payload;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, 5000 - (performance.now() - started))); });
  const frame = await Promise.race([firstFrame, deadline]).finally(() => clearTimeout(timer));
  assert.ok(frame && frame[0] === 0xff && frame[1] === 0xd8, "JPEG frame within 5 s");
  await post(1, tap);
  await post(2, [{ t: "text", value: "typed-7311" }]);
  assert.equal(await app.main(`${subject}.view.webContents.executeJavaScript("document.querySelector('input').value")`), "typed-7311");
  await app.gateway.api(`/authority-requests/${encodeURIComponent(requestRef)}/hand-back?session_id=general`, { method: "POST", body: "{}" });
  for (;;) {
    const next = await reader.next();
    assert.ok(!next.done, "stream closed without an end record");
    if (next.value.type !== 4) continue;
    assert.equal(JSON.parse(next.value.payload.toString()).reason, "handed_back");
    assert.equal((await reader.next()).done, true);
    break;
  }
  await app.delivered();
  assert.doesNotMatch(modelMessages, /typed-7311/u);
  assert.match(modelMessages, /entered by user \(hidden\)/u);
} finally {
  stream.abort();
  await app.stop();
}
