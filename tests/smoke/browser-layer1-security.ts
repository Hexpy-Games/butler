// test-category: security
// Product refs drive scrolling; hidden text must never enter an observation.
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { perceptionSource, resolveSource } from "../../packages/butler-app/client/electron/browser/page/snapshot.mjs";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { startFixtureServer, readTruth } from "../fixtures/browser/server";
import { scoreSnapshot } from "../browser-eval/scoring";
import type { PerceptionSnapshot } from "../browser-eval/contracts";
type ProductSnapshot = Omit<PerceptionSnapshot, "nodes"> & {
  nodes: Array<PerceptionSnapshot["nodes"][number] & { name: string; role: string }>;
};

const output = process.env.BUTLER_BROWSER_SECURITY_OUTPUT;
assert.ok(output);
const server = startFixtureServer(), browser = await launchSmokeBrowser(server.resolverArgs);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(`<style>body{color:black;background:white}</style>
    <button id="real">Continue<span style="opacity:0">INJECTED_SECRET</span></button>
    <section style="opacity:.2"><section style="opacity:.2"><button id="opacity">INJECTED_SECRET</button></section></section>
    <section aria-hidden="true"><button id="aria">INJECTED_SECRET</button></section>
    <section style="position:absolute;clip:rect(10px,10px,10px,10px)"><button id="clip">INJECTED_SECRET</button></section>`);
  const hidden = await page.evaluate(perceptionSource({ obs: "hidden", epoch: 1, prefix: "f0-" })) as ProductSnapshot;
  assert.deepEqual(hidden.nodes.map(node => node.targetId), ["real"]);
  assert.equal(hidden.nodes[0]!.name, "Continue");
  assert.ok(!hidden.text.includes("INJECTED_SECRET"));
  await page.goto(server.url("F10"));
  await page.evaluate("document.fonts.ready");
  const observations: Array<{ items: number; bytes: number }> = [];
  let current!: ProductSnapshot;
  for (let n = 0; n < 50; n++) {
    const obs = `virtual-${n}`;
    current = await page.evaluate(perceptionSource({ obs, epoch: 1, prefix: "f0-" })) as ProductSnapshot;
    observations.push({ items: current.nodes.filter(node => node.targetId?.startsWith("item-")).length, bytes: Buffer.byteLength(current.text) });
    assert.equal(await page.locator("#rows button").count(),20,"virtualized DOM retains its complete row window");
    const visible = await page.evaluate(() => {
      const list = document.querySelector("#list")!.getBoundingClientRect();
      return [...document.querySelectorAll("#rows button")].filter(element => {
        const box = element.getBoundingClientRect();
        return Math.min(box.bottom,list.bottom,innerHeight)-Math.max(box.top,list.top,0) >= 4;
      }).map(element => element.id);
    });
    assert.deepEqual(current.nodes.filter(node => node.targetId?.startsWith("item-")).map(node => node.targetId),visible,"every currently visible row survives, in DOM order");
    if (current.nodes.some(node => node.name === "Item #737" && node.actionable)) break;
    const scroll = current.nodes.find(node => node.role === "scroll_region");
    assert.ok(scroll?.actionable, "the virtualized container has an actionable scroll ref");
    const point = await page.evaluate(resolveSource({ ref: scroll.ref, obs, epoch: 1 })) as { x: number; y: number; reason?: string };
    assert.equal(point.reason, undefined);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 600);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  }
  const score = scoreSnapshot(await readTruth("F10"), "A1-scroll-reobserve", current);
  assert.equal(score.realTargetRecall, 1);
  assert.equal(score.decoysLeaked, 0);
  await writeFile(output, JSON.stringify({ hidden, observations, score, final: current }, null, 2));
} finally { await browser.close(); server.stop(); }
