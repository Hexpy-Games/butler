/** Real App acceptance beyond navigation, using the existing inspector seam. */
import { strict as assert } from "node:assert";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { ElectronPage } from "./electron-page-cdp";

type Main = <T>(expression: string) => Promise<T>;
export async function alignment(page: ElectronPage, main: Main, win: string, evidence: string) {
  const samples: unknown[] = [];
  const rightOpen = await page.expression("Boolean(document.querySelector('button[aria-label=\"Hide right panel\"]'))");
  const right = rightOpen ? ["Hide right panel", "Show right panel"] : ["Show right panel", "Hide right panel"];
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

/** Change observation plus exact metadata snapshots; no periodic whole-file reads. */
export async function idleWrites(main: Main, profile: string, evidence: string, pids: number[], repeated = false) {
  await new Promise(done=>setTimeout(done, 3000));
  await main(`(() => {
    const fs=process.getBuiltinModule('node:fs');
    const directory=${JSON.stringify(join(profile, "browser"))};
    const path=directory+'/browser-tabs.json';
    const stat=fs.statSync(path);
    globalThis.browserIdle={events:[],before:{size:stat.size,mtime:stat.mtimeMs,content:fs.readFileSync(path,'utf8')}};
    globalThis.browserIdle.watcher=fs.watch(directory,(event,file)=>globalThis.browserIdle.events.push({event,file}));
  })()`);
  const ioBefore = processIo(pids);
  const loadStart = loadavg()[0];
  const started = Date.now();
  const loads = [loadStart];
  // Keep this a real ten-minute window; callers may not shorten acceptance.
  for (let minute = 0; minute < 10; minute++) {
    await new Promise(done=>setTimeout(done, 60_000));
    loads.push(loadavg()[0]);
    console.log(`Browser idle ${minute + 1}/10 min; load1m=${loads.at(-1)}`);
  }
  const result = await main<{ events: unknown[]; before: unknown; after: unknown }>(`(() => {
    const fs=process.getBuiltinModule('node:fs');
    const path=${JSON.stringify(join(profile, "browser/browser-tabs.json"))};
    const idle=globalThis.browserIdle;idle.watcher.close();const stat=fs.statSync(path);
    return {events:idle.events,before:idle.before,after:{size:stat.size,mtime:stat.mtimeMs,content:fs.readFileSync(path,'utf8')}};
  })()`);
  const ioAfter = processIo(pids);
  assert.deepEqual(result.events, [], "no browser restore writes during idle");
  assert.deepEqual(result.after, result.before, "complete ordered restore state unchanged");
  const measurement = JSON.stringify({ durationMs: Date.now()-started,
    loadAverage1m: loadStart, loadAverage1mAfter: loadavg()[0], loadAverage1mSamples: loads, browserRestoreWriteBytes: 0, processWriteBytes: ioAfter.reduce((sum, sample)=>sum+sample.write_bytes, 0)-ioBefore.reduce((sum, sample)=>sum+sample.write_bytes, 0), ioBefore, ioAfter, ...result });
  writeFileSync(join(evidence, "idle-writes.json"), measurement);
  if (Math.max(...loads) > cpus().length && !repeated) {
    writeFileSync(join(evidence, `idle-writes-high-load-${started}.json`), measurement);
    console.log("Repeating ten-minute idle measurement after high shared-machine load");
    await idleWrites(main, profile, evidence, pids, true);
  }
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

function processIo(pids: number[]): Array<{ pid: number; write_bytes: number }> {
  const executable = process.env.BUTLER_PROCESS_USAGE_EXECUTABLE;
  assert.ok(executable, "BUTLER_PROCESS_USAGE_EXECUTABLE must name the platform process-usage example");
  const result = Bun.spawnSync([executable, ...pids.map(String)]);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const samples = JSON.parse(result.stdout.toString()) as Array<{ pid: number; write_bytes: number }>;
  assert.deepEqual(samples.map(sample=>sample.pid), pids, "all owned process counters returned");
  return samples;
}
