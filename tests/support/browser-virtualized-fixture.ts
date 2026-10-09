import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { perceptionSource, resolveSource } from "../../packages/butler-app/client/electron/browser/page/snapshot.mjs";
import type { PerceptionSnapshot } from "../browser-eval/contracts";
export type ProductSnapshot = Omit<PerceptionSnapshot, "nodes"> & {
  nodes: Array<PerceptionSnapshot["nodes"][number] & { name: string; role: string }>;
};

/** Reobserve the virtualized fixture after scrolling by its current product ref. */
export async function scrollVirtualizedFixture(page: Page) {
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
  assert.ok(current.nodes.some(node => node.name === "Item #737" && node.actionable));
  return { current, observations };
}
