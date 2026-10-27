import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Surface } from "./classic-scrollbar-gap-surfaces.ts";

export type Frame = { frame: number; time: number; left: number; right: number; dpr: number; clientWidth?: number; overflows?: boolean };
export function deltas(records: Frame[]) {
  const changes = records.slice(1).flatMap((item, i) => {
    const left = item.left - records[i].left, right = item.right - records[i].right;
    return left !== 0 || right !== 0 ? [{ from: records[i].frame, frame: item.frame, left, right }] : [];
  });
  const dpr = records[0]?.dpr ?? 1;
  const device = (value: number) => Math.round(Math.abs(value) * dpr) * Math.sign(value);
  return { dpr, devicePixels: {
    maxLeft: Math.max(0, ...changes.map(change => Math.abs(device(change.left)))),
    maxRight: Math.max(0, ...changes.map(change => Math.abs(device(change.right)))),
    steadyLeft: records.length ? device(records.at(-1)!.left - records[0].left) : null,
    steadyRight: records.length ? device(records.at(-1)!.right - records[0].right) : null,
  }, count: records.length, maxLeft: Math.max(0, ...records.slice(1).map((r, i) => Math.abs(r.left - records[i].left))),
    maxRight: Math.max(0, ...records.slice(1).map((r, i) => Math.abs(r.right - records[i].right))), changes,
    steadyLeft: records.length ? records.at(-1)!.left - records[0].left : null,
    steadyRight: records.length ? records.at(-1)!.right - records[0].right : null };
}

// rAF is pre-paint. RO keeps the last delivered layout observation in each
// rAF interval. Neither is called painted evidence; that comes from CDP pixels.
export async function startFrames(page: Page, surface: Surface) {
  const rafReads = process.env.BUTLER_SCROLLBAR_GAP_RAF_READS !== "0";
  await page.locator(surface.s).first().evaluate((s, { selector, rafReads }) => {
    const c = selector === ":scope" ? s : s.querySelector(selector);
    if (!(c instanceof HTMLElement)) throw new Error("Missing frame content reference");
    let frame = 0, active = true, raf = 0;
    const records: Frame[] = [], ro = new Map<number, Frame>();
    const clock: { frame: number; time: number }[] = [];
    const shifts: unknown[] = [];
    const read = (): Frame => {
      const r = c.getBoundingClientRect();
      return { frame, time: performance.timeOrigin + performance.now(), left: r.left, right: r.right, dpr: devicePixelRatio,
        clientWidth: s.clientWidth, overflows: s.scrollHeight > s.clientHeight + 1 };
    };
    const observer = new ResizeObserver(() => ro.set(frame, read()));
    for (let node: Element | null = c; node; node = node.parentElement) {
      observer.observe(node);
      if (node === s) break;
    }
    const performanceObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean; sources: { node: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] };
        shifts.push({ frame, startTime: shift.startTime, value: shift.value, hadRecentInput: shift.hadRecentInput,
          sources: shift.sources.map(source => ({ content: source.node === c, inside: c.contains(source.node),
            previousRect: source.previousRect.toJSON(), currentRect: source.currentRect.toJSON() })) });
      }
    });
    performanceObserver.observe({ type: "layout-shift" });
    const ticker = document.createElement("div");
    ticker.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;z-index:2147483647;pointer-events:none";
    document.body.append(ticker);
    const original = c.style.outline, offset = c.style.outlineOffset;
    c.style.outline = "2px solid rgb(255, 0, 255)";
    c.style.outlineOffset = "-2px";
    const tick = () => {
      if (!active) return;
      frame++;
      clock.push({ frame, time: performance.timeOrigin + performance.now() });
      if (rafReads) records.push(read());
      ticker.style.backgroundColor = frame % 2 ? "black" : "white";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    (window as any).__gapFrames = { read, stop: () => {
      active = false; cancelAnimationFrame(raf); observer.disconnect(); performanceObserver.disconnect();
      ticker.remove(); c.style.outline = original; c.style.outlineOffset = offset;
      return { raf: records, clock, rafReads, resizeObserver: [...ro.values()], layoutShifts: shifts };
    } };
  }, { selector: surface.c, rafReads });
}

export async function waitFrames(page: Page, count: number) {
  await page.evaluate(count => new Promise<void>(done => {
    const tick = () => { if (--count <= 0) done(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), count);
}

export async function sampleTransition(page: Page, surface: Surface, trigger: () => Promise<void>, label: string) {
  await startFrames(page, surface);
  const session = await page.context().newCDPSession(page);
  const images: { data: string; timestamp: number }[] = [];
  session.on("Page.screencastFrame", event => {
    images.push({ data: event.data, timestamp: Number(event.metadata.timestamp) * 1000 });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  try {
    await session.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1280, maxHeight: 2400 });
    await waitFrames(page, 12);
    const before = await page.evaluate(() => (window as any).__gapFrames.read() as Frame);
    await trigger();
    await waitFrames(page, 30);
    const after = await page.evaluate(() => (window as any).__gapFrames.read() as Frame);
    await session.send("Page.stopScreencast");
    const dom = await page.evaluate(() => (window as any).__gapFrames.stop() as {
      raf: Frame[]; clock: { frame: number; time: number }[]; rafReads: boolean; resizeObserver: Frame[]; layoutShifts: unknown[];
    });
    if (process.env.BUTLER_SCROLLBAR_GAP_SHOTS) images.forEach((image, index) => {
      writeFileSync(join(process.env.BUTLER_SCROLLBAR_GAP_SHOTS!, `${label}-frame-${index}.png`), Buffer.from(image.data, "base64"));
    });
    const { painted, unmarked } = await decodeFrames(page, images, dom.clock);
    return { before, after, ...dom, painted, unmarked, summaries: {
      raf: deltas(dom.raf), resizeObserver: deltas(dom.resizeObserver), painted: deltas(painted),
    }, screencastFrames: images.length };
  } finally {
    await page.evaluate(() => (window as any).__gapFrames?.stop()).catch(() => {});
    await session.detach();
  }
}

async function decodeFrames(page: Page, images: { data: string; timestamp: number }[], raf: { frame: number; time: number }[]) {
  return page.evaluate(async ({ images, raf }) => {
    const records: Frame[] = [];
    const unmarked: { index: number; time: number; width: number; height: number }[] = [];
    const canvas = new OffscreenCanvas(1, 1), ctx = canvas.getContext("2d")!;
    for (const { data, timestamp } of images) {
      if (!Number.isFinite(timestamp)) throw new Error("Screencast has no compositor timestamp");
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let left = bitmap.width, right = -1;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 240 && pixels[i + 1] < 20 && pixels[i + 2] > 240) {
          const x = (i / 4) % bitmap.width;
          left = Math.min(left, x); right = Math.max(right, x);
        }
      }
      const scale = bitmap.width / innerWidth;
      if (right < left) unmarked.push({ index: records.length + unmarked.length, time: timestamp, width: bitmap.width, height: bitmap.height });
      bitmap.close();
      if (right < left) continue;
      const nearest = raf.reduce((a, b) => Math.abs(b.time - timestamp) < Math.abs(a.time - timestamp) ? b : a);
      records.push({ frame: nearest.frame, time: timestamp, left: left / scale, right: (right + 1) / scale, dpr: devicePixelRatio });
    }
    return { painted: records, unmarked };
  }, { images, raf });
}

export function assertTransition(result: Awaited<ReturnType<typeof sampleTransition>>) {
  assert.equal(result.before.overflows, false, "Transition must start with fitting content");
  assert.equal(result.after.overflows, true, "Transition must end with overflowing content");
  // A screencast can begin with a cached frame from before the marker was
  // installed. Only pre-trigger cache frames may be unmarked; retain them in
  // the report and fail on any coverage loss during/after the transition.
  assert.deepEqual(result.unmarked.filter(frame => frame.time >= result.before.time), [], "Painted content marker disappeared after arming");
  for (const [name, summary] of Object.entries(result.summaries)) {
    if (name === "raf" && !result.rafReads) continue;
    assert(summary.count >= 2, `${name}: insufficient frame coverage`);
    assert(summary.devicePixels.maxLeft === 0 && summary.devicePixels.maxRight === 0, `${name}: per-frame column shift ${JSON.stringify(summary)}`);
    assert(summary.devicePixels.steadyLeft === 0 && summary.devicePixels.steadyRight === 0, `${name}: steady column shift`);
  }
}
