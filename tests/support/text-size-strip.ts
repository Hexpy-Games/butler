// test-category: race
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronPage } from "./electron-page-cdp";
import type { connectElectronMain } from "./electron-main-cdp";
import { focusRingProbeInPage } from "./focus-ring-clipping";

type Main = Awaited<ReturnType<typeof connectElectronMain>>;

/** Read the production fade signals and the actual card bounds, without changing layout. */
function stripState() {
  const rail = document.querySelector<HTMLElement>('[data-test-class="new-chat-suggestion-rail"]')!;
  const cards = [...rail.querySelectorAll<HTMLElement>('[data-test-class="new-chat-suggestion"]')];
  const r = rail.getBoundingClientRect(), last = cards.at(-1)!.getBoundingClientRect();
  const css = getComputedStyle(rail);
  const composer = document.querySelector('[data-test-class="composer-card"]')!.getBoundingClientRect();
  return { scrollWidth: rail.scrollWidth, clientWidth: rail.clientWidth, left: rail.scrollLeft,
    max: rail.scrollWidth - rail.clientWidth, count: cards.length,
    axis: rail.dataset.scrollFade, overflowing: rail.dataset.overflowing, mask: css.maskImage,
    start: parseFloat(css.getPropertyValue('--scroll-fade-start')), end: parseFloat(css.getPropertyValue('--scroll-fade-end')),
    lastInside: last.left >= r.left - 1 && last.right <= r.right + 1,
    lastFocused: cards.at(-1)!.contains(document.activeElement),
    vertical: cards.map(card => { const box = card.getBoundingClientRect();
      return box.top >= Math.max(0, r.top) - 1 && box.bottom <= Math.min(innerHeight, composer.top, r.bottom) + 1; }),
  };
}

export async function checkSuggestionStrips(page: ElectronPage, main: Main, win: string, evidence: string) {
  const rows: unknown[] = [];
  const settle = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const read = async () => { await settle(); return page.evaluate(stripState); };
  const position = async (end: boolean) => {
    await page.expression(`(()=>{const r=document.querySelector('[data-test-class="new-chat-suggestion-rail"]');r.scrollLeft=${end ? 'r.scrollWidth' : '0'};})()`);
    return read();
  };
  const fade = (state: Awaited<ReturnType<typeof read>>) => {
    if (state.max - state.left > 1) {
      assert.equal(state.axis, 'x'); assert.equal(state.overflowing, 'true');
      assert(state.end > 0 && state.mask !== 'none', `right fade: ${JSON.stringify(state)}`);
    } else assert.equal(state.end, 0, 'right fade off at end');
  };
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const [size, scale] of [['large', 1.15], ['larger', 1.3]] as const) {
      await page.expression(`window.butlerApp.setTextSize(${JSON.stringify(size)})`);
      await main.evaluate(`${win}.setContentSize(${width},${height})`);
      await page.expression(`new Promise(done=>{const check=()=>Math.abs(innerWidth*${scale}-${width})<=1?done(true):setTimeout(check,20);check()})`);
      const start = await position(false);
      assert(start.count > 1, 'all suggestion cards present');
      assert(start.scrollWidth > start.clientWidth, `strip overflows at ${width}/${scale}`); fade(start);
      const end = await position(true); fade(end); assert(end.lastInside, 'scroll reaches the last card');
      // Each card must be vertically reachable above the composer, including at 130%.
      for (let index = 0; index < start.count; index++) {
        await page.expression(`document.querySelectorAll('[data-test-class="new-chat-suggestion"]')[${index}].scrollIntoView({block:'nearest',inline:'nearest'})`);
        const state = await read();
        assert(state.vertical[index], `card ${index} vertically reachable at ${width}/${scale}: ${JSON.stringify(state)}`);
      }
      await position(false);
      await page.expression(`document.querySelector('[data-test-class="new-chat-suggestion"] button,[data-test-class="new-chat-suggestion"] [role="button"]').focus()`);
      for (let index = 1; index < start.count; index++) {
        await main.evaluate(`${win}.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});${win}.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'})`);
        await settle();
      }
      const keyboard = await read(); fade(keyboard);
      assert(keyboard.lastFocused && keyboard.lastInside, `Tab reaches last card: ${JSON.stringify(keyboard)}`);
      const ring = await page.evaluate(focusRingProbeInPage);
      assert(ring && !ring.noIndicator, 'last card paints a focus ring');
      assert.deepEqual(ring.clips, [], 'last card focus ring is not cut');
      writeFileSync(join(evidence, `strip-keyboard-${width}-${scale}.png`), await page.screenshot());
      await page.expression('(document.activeElement).blur()');
      await position(false);
      const wheelPositions: number[] = [];
      let trackpad = await read();
      // A sequence of real native wheel inputs, with no synthetic DOM scroll events.
      for (let input = 0; input < 40 && !trackpad.lastInside; input++) {
        const point = await page.evaluate(() => {
          const r = document.querySelector('[data-test-class="new-chat-suggestion-rail"]')!.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        // DOM client coordinates times the App zoom are the window's DIPs.
        await main.evaluate(`(()=>{const wc=${win}.webContents;const z=wc.getZoomFactor();
          const x=Math.round(${point.x}*z),y=Math.round(${point.y}*z);wc.sendInputEvent({type:'mouseMove',x,y});
          wc.sendInputEvent({type:'mouseWheel',x,y,deltaX:-120,deltaY:0,canScroll:true});})()`);
        trackpad = await read(); fade(trackpad); wheelPositions.push(trackpad.left);
      }
      assert(trackpad.left > 0 && trackpad.lastInside, `trackpad reaches last card: ${JSON.stringify(trackpad)}`);
      const row = { width, height, scale, start, end, keyboard, ring, trackpad, wheelPositions };
      rows.push(row); console.log(JSON.stringify({ suggestionStrip: row }));
      writeFileSync(join(evidence, 'suggestion-strips.json'), JSON.stringify(rows, null, 2));
    }
  }
}
