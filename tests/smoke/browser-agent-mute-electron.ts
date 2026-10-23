// test-category: race
/** Pages Butler opens are silent until the user takes the tab over. Real App, offline fixture, stub only:
 * Butler opens a page that loops a local clip; it plays muted. Butler's hand-off (wait for the user)
 * unmutes it, and it stays unmuted after control returns to Butler. A second Butler tab the user drags
 * into their own tabs unmutes too; a tab the user opens is never muted. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { hostResolverRules, publicResolverPatch } from "../support/signin-fixtures";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
/** One second of a 440 Hz tone, 8 kHz 16-bit mono PCM. */
function clip(): ArrayBuffer {
  const rate = 8000, samples = rate, bytes = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, value: string) => [...value].forEach((char, index) => bytes.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF"); bytes.setUint32(4, 36 + samples * 2, true); text(8, "WAVEfmt "); bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true);
  bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, "data"); bytes.setUint32(40, samples * 2, true);
  for (let n = 0; n < samples; n++) bytes.setInt16(44 + n * 2, Math.round(Math.sin(2 * Math.PI * 440 * n / rate) * 12000), true);
  return bytes.buffer as ArrayBuffer;
}
const wav = clip();
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (new URL(request.url).pathname === "/clip.wav") return new Response(wav, { headers: { "content-type": "audio/wav" } });
  return new Response('<!doctype html><meta charset="utf-8"><title>Clip</title><h1>Clip</h1><audio id="clip" src="/clip.wav" loop autoplay></audio>', { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const page = `http://www.fixture-shop.test:${fixture.port}/`;
process.env.BUTLER_SMOKE_ELECTRON_ARGS = JSON.stringify([...JSON.parse(process.env.BUTLER_SMOKE_ELECTRON_ARGS ?? "[]"), hostResolverRules()]);
const app = await browserAgentApp(evidence, () => null);
const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})`;
const tabOf = (id: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})`;
const execute = <T>(op: string, tab?: string, args: unknown = {}) => app.main<T>(`globalThis.browserAgentSubject.execute(${JSON.stringify({ op, tab, args, session: "general" })})`);
/** Whether the clip plays, and whether Chromium mutes the tab's sound. */
const sound = (id: string) => app.main<{ playing: boolean; muted: boolean; holder: string }>(`(async()=>{const t=${tabOf(id)};
  const playing=await t.view.webContents.executeJavaScript("(()=>{const a=document.getElementById('clip');return Boolean(a)&&!a.paused&&a.currentTime>0})()");
  return {playing,muted:t.view.webContents.isAudioMuted(),holder:t.holder}})()`);
const playing = (id: string, label: string) => waitBrowser(async () => (await sound(id)).playing, label);
const results: Record<string, unknown> = {};

try {
  await app.main(publicResolverPatch(module));
  await app.call("open");
  // Butler opens the page: the clip plays, muted.
  const opened = await execute<{ status: string; tab: string }>("tab.open", undefined, { url: page });
  assert.equal(opened.status, "ok", JSON.stringify(opened));
  await playing(opened.tab, "Butler's page plays the clip");
  results.opened = await sound(opened.tab);
  assert.deepEqual(results.opened, { playing: true, muted: true, holder: "agent" }, "Butler's tab starts muted");
  // Butler hands the tab to the user: their tab now, with its sound.
  const wait = await execute<{ status: string }>("tab.wait", opened.tab, { reason: "sign_in" });
  assert.equal(wait.status, "user_control", JSON.stringify(wait));
  results.handedOver = await sound(opened.tab);
  assert.deepEqual(results.handedOver, { playing: true, muted: false, holder: "user" }, "the hand-off unmutes");
  await app.call("control", { id: opened.tab, holder: "agent" });
  results.givenBack = await sound(opened.tab);
  assert.deepEqual(results.givenBack, { playing: true, muted: false, holder: "agent" }, "giving it back keeps the sound");

  // A second Butler tab, dragged into the user's own tabs, unmutes.
  const second = await execute<{ status: string; tab: string }>("tab.open", undefined, { url: page });
  assert.equal(second.status, "ok", JSON.stringify(second));
  await playing(second.tab, "the second page plays");
  assert.equal((await sound(second.tab)).muted, true);
  await app.call("move", { tabId: second.tab, toGroupId: "mine", index: 0 });
  results.moved = await sound(second.tab);
  assert.deepEqual(results.moved, { playing: true, muted: false, holder: "user" }, "moving it to my tabs unmutes");

  // The user's own tab plays with sound from the start.
  const mine = await app.call<string>("create", { url: page });
  await waitBrowser(() => app.main(`Boolean(${tabOf(mine)}.view)`), "the user's tab has a page");
  await playing(mine, "the user's page plays");
  results.mine = await sound(mine);
  assert.deepEqual(results.mine, { playing: true, muted: false, holder: "user" }, "the user's tab is never muted");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, ...results }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), results, state: await app.call("state").catch(() => null) }, null, 2));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); fixture.stop(true); }
