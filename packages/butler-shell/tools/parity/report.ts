import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Box } from "./scene.ts";

const escape = (text: string) => text.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const layout = (out: string, app: string, name: string) => JSON.parse(readFileSync(join(out, app, `${name}.layout.json`), "utf8")) as Box[];

function crop(app: string, name: string, box: Box, width: number) {
  return `<figure><figcaption>${app}</figcaption><div class="crop" style="width:${box.w * 2}px;height:${box.h * 2}px"><img alt="${escape(box.anchor)}" src="${app}/${encodeURIComponent(name)}.png" style="width:${width * 2}px;left:${-box.x * 2}px;top:${-box.y * 2}px"></div></figure>`;
}

export function report(out: string) {
  const rows: string[] = [];
  for (const file of readdirSync(join(out, "electron")).filter(file => file.endsWith(".png")).sort()) {
    const name = file.slice(0, -4);
    const a = layout(out, "electron", name), b = layout(out, "gpui", name);
    const size = name.match(/-(\d+)x(\d+)-(light|dark)$/u)!;
    rows.push(`<section><h2>${escape(name)}</h2><div class="pair">${["electron", "gpui", "diff"].map(app => `<figure><figcaption>${app === "diff" ? "Heatmap" : app}</figcaption><img alt="${app}" src="${app}/${encodeURIComponent(name)}${app === "diff" ? ".heat" : ""}.png"></figure>`).join("")}</div>`);
    for (const anchor of new Set([...a, ...b].map(box => box.anchor))) {
      const left = a.find(box => box.anchor === anchor), right = b.find(box => box.anchor === anchor);
      let line: string;
      if (left && right) {
        const delta = (["x", "y", "w", "h"] as const).map(key => (right[key] - left[key]).toFixed(2));
        line = `${name} ${anchor} Δx ${delta[0]} Δy ${delta[1]} Δw ${delta[2]} Δh ${delta[3]}`;
      } else line = `${name} ${anchor} missing in ${left ? "gpui" : "electron"}`;
      console.log(line);
      rows.push(`<h3>${escape(anchor)}</h3><p>${escape(line)}</p><div class="crops">${left ? crop("electron", name, left, Number(size[1])) : "<p>Electron: absent</p>"}${right ? crop("gpui", name, right, Number(size[1])) : "<p>gpui: absent</p>"}</div>`);
    }
    rows.push("</section>");
  }
  const pixels = readFileSync(join(out, "logs", "pixel-diff.log"), "utf8");
  writeFileSync(join(out, "report.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screenshot parity</title><style>
:root{color-scheme:light dark;font:14px system-ui;background:#fafafa;color:#222}body{margin:16px}h2{overflow-wrap:anywhere}section{margin-bottom:48px}figure{margin:0;min-width:0}figcaption{padding:8px 0}img{display:block;max-width:100%}.pair{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.crops{overflow:auto;display:grid;gap:12px}.crop{position:relative;overflow:hidden;background:#888}.crop img{position:absolute;max-width:none}p{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){.pair{grid-template-columns:1fr}}@media(prefers-color-scheme:dark){:root{background:#181818;color:#eee}}
</style><h1>Electron ↔ gpui</h1><p>Pixel differences are review evidence. No threshold is asserted.</p><pre>${escape(pixels)}</pre>${rows.join("\n")}</html>`);
}
