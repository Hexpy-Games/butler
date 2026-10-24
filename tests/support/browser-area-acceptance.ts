/** Real App acceptance beyond navigation, using the existing inspector seam. */
import { strict as assert } from "node:assert";
import { loadavg } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { ElectronPage } from "./electron-page-cdp";

type Main = <T>(expression: string) => Promise<T>;
export async function alignment(page: ElectronPage, main: Main, win: string, evidence: string) {
  const samples: unknown[] = [];
  const rightOpen = await page.expression("Boolean(document.querySelector('button[aria-label=\"Hide right panel\"]'))");
  const available = await page.expression("Boolean(document.querySelector('button[aria-label=\"Show right panel\"],button[aria-label=\"Hide right panel\"]'))");
  const right = !available ? [] : rightOpen ? ["Hide right panel", "Show right panel"] : ["Show right panel", "Hide right panel"];
  for (const name of ["Hide sidebar", "Show sidebar", ...right]) {
    const button = `Array.from(document.querySelectorAll('button')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)})`;
    assert.ok(await page.expression(`Boolean(${button})`), name);
    await page.expression(`(${button}).click()`);
    for (let index = 0; index < 20; index++) {
      samples.push(await main(`(async () => {
        const w=${win};
        const dom=await w.webContents.executeJavaScript("(() => {const s=document.querySelector('[data-slot=native-view-slot]');const r=document.querySelector('[data-slot=native-view-frame]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,covered:s.hasAttribute('data-occluded'),still:Boolean(s.querySelector('img'))}})()");
        const v=w.contentView.children.find(v=>'webContents' in v && v.webContents!==w.webContents);
        return {dom,native:v?.getBounds() ?? null};
      })()`));
      await new Promise(done=>setTimeout(done, 25));
    }
    const sample = samples.at(-1) as { dom: { x: number; y: number; width: number; height: number; covered: boolean }; native: Record<string, number> | null };
    assert.equal(sample.dom.covered, false, `${name} settles`);
    assert.ok(sample.native, `${name} native view reattached`);
    for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(sample.native[key]! - sample.dom[key]) <= 1, `${name} ${key}`);
  }
  assert.ok(samples.some(sample => (sample as { native: unknown }).native === null), "native view detaches during panel animation");
  writeFileSync(join(evidence, "alignment.json"), JSON.stringify({ samples, loadAverage1m: loadavg()[0] }));
}

export function publicationStub() {
  let round = 0;
  return (request: { stream: boolean; messages: unknown[] }) => {
    if (!request.stream || !JSON.stringify(request.messages).includes("Publish browser output")) return null;
    round++;
    if (round === 1) return { name: "write_file", arguments: { path: "site/index.html",
      content: "<!doctype html><title>Published Browser Output</title><h1>Complete output</h1>", create_parents: true } };
    if (round === 2) return { name: "output_publish", arguments: { path: "site", title: "Output" } };
    return null;
  };
}
