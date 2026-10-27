import assert from "node:assert/strict";
import type { ElectronPage } from "./electron-page-cdp";
import { visibleClipping } from "./visible-clipping";

/** Geometry checks for the checker itself, in the same real Electron renderer. */
export async function verifyVisibleClipping(page: ElectronPage) {
  const cases = [
    { name: "ancestor-right", css: "overflow:hidden", child: "width:120px", expected: ["right"] },
    { name: "horizontal-scroll", css: "overflow-x:auto;overflow-y:hidden;height:20px", child: "width:120px", expected: [] },
    { name: "horizontal-scroll-hidden-y", css: "overflow-x:auto;overflow-y:hidden;height:20px", child: "width:120px;height:40px", expected: ["bottom"] },
    { name: "scroller-nonscrolling-axis", css: "overflow-x:auto;overflow-y:hidden;height:40px", child: "width:100px;margin-left:-10px", expected: ["left"] },
    { name: "viewport-right", css: "overflow:visible;width:500px", child: "width:500px", expected: ["right"] },
    { name: "ancestor-left", css: "overflow:clip", child: "width:100px;margin-left:-10px", expected: ["left"] },
    { name: "ancestor-bottom", css: "overflow:hidden;height:10px", child: "height:30px", expected: ["bottom"] },
    { name: "vertical-scroll", css: "overflow-y:auto;height:10px", child: "height:30px", expected: [] },
    { name: "ellipsis", css: "overflow:hidden", child: "width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", expected: [] },
    { name: "ancestor-ellipsis", css: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", child: "display:inline", text: "Readable text that exceeds the container", expected: [] },
    { name: "ancestor-ellipsis-bottom", css: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:10px", child: "display:inline-block;height:30px", expected: ["bottom"] },
    { name: "ellipsis-with-wrap", css: "overflow:hidden", child: "width:120px;text-overflow:ellipsis;white-space:normal", expected: ["right"] },
    { name: "clamp", css: "overflow:hidden", child: "width:120px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2", expected: [] },
    { name: "hidden-panel", css: "overflow:hidden", child: "width:120px", attribute: "hidden", expected: [] },
    { name: "inert-panel", css: "overflow:hidden", child: "width:120px", attribute: "inert", expected: [] },
    { name: "decorative", css: "overflow:hidden", child: "width:120px", attribute: 'aria-hidden="true"', expected: [] },
    { name: "visually-hidden-parent", css: "overflow:hidden;width:1px;height:1px;clip-path:inset(50%)", child: "width:120px", expected: [] },
    { name: "visible", css: "overflow:hidden", child: "width:90px", expected: [] },
  ];
  await page.expression(`(()=>{const frame=document.createElement('iframe');frame.id='clipping-checker-fixture';
    frame.style.cssText='position:fixed;inset:0;width:400px;height:200px;z-index:2147483647';document.body.append(frame)})()`);
  try {
    for (const cell of cases) {
      const html = `<style>body{margin:20px}#clip{width:100px;${cell.css}}#text{box-sizing:border-box;${cell.child}}</style><div id="clip" ${cell.attribute ?? ""}><div id="text">${cell.text ?? "Readable text"}</div></div>`;
      const actual = await page.expression<Array<{ side:string }>>(`(()=>{const doc=document.querySelector('#clipping-checker-fixture').contentDocument;
        doc.open();doc.write(${JSON.stringify(html)});doc.close();return doc.defaultView.eval('('+${JSON.stringify(visibleClipping.toString())}+')()')})()`);
      assert.deepEqual([...new Set(actual.map(row=>row.side))].sort(), cell.expected.sort(), cell.name);
    }
    console.log(JSON.stringify({ visibleClippingCheckerCases:cases.length, result:"PASS" }));
  } finally { await page.expression("document.querySelector('#clipping-checker-fixture').remove()"); }
}
