import { appLog } from "../log/runtime.mjs";
import { BrowserWindow, nativeImage } from "electron";
import { isIP } from "node:net";
import { guardUrl, privateAddress } from "./guard.mjs";
import { snapshotFonts, inlineSnapshotBlobs } from "./snapshot-page-resources.mjs";
import { snapshotPage } from "./snapshot-page.mjs";
import { capturePage } from "./view-capture.mjs";

/**
 * A scrap's self-contained HTML copy of exactly the picked element (or area): the page's DOM with computed
 * styles inline (snapshot-page.mjs), resources and fonts inlined as data: URLs, cross-origin frames filled from
 * their own worlds and unreadable media cropped from the screen. The copy has no scripts, handlers, form actions
 * or remote loads, and its CSP admits only inline styles and data: images and fonts.
 */
export const SNAPSHOT_SOURCE = `(args) => (${snapshotPage.toString()})(args, ${snapshotFonts.toString()}, ${inlineSnapshotBlobs.toString()})`;
export const SNAPSHOT_LIMIT = 5 * 1024 * 1024;
const ASSET_LIMIT = 3 * 1024 * 1024, FONT_BUDGET = 2.5 * 1024 * 1024, SHEET_LIMIT = 512 * 1024, FRAME_DEPTH = 4;
const CLEAR = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const MASK = [0xd9, 0xd9, 0xd9, 0xff];
const CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
// The viewer resets every element of the copy (outside SVG and MathML content) so only the inline styles apply.
const RESET = [":where(body *:not(svg *):not(math *):not([data-native]))", ":where(body foreignObject *:not([data-native]))"].flatMap(base => [base, `${base}::before`, `${base}::after`]).join(",");

const CONTROLS = ["button", "select", "textarea", "meter", "progress", ...["text", "search", "email", "url", "tel", "number", "password", "date", "time",
  "datetime-local", "month", "week", "color", "checkbox", "radio", "range", "file", "submit", "reset", "button", "image"].map(type => `input:${type}`)];
let initial = null;
/**
 * Every computed property's initial value in this Electron, and each native control's own defaults (where they
 * differ), read once from a blank hidden page.
 */
export function initialValues() {
  initial ??= (async () => {
    const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await win.loadURL("about:blank");
      return await win.webContents.executeJavaScript(`(()=>{const read=el=>{const s=getComputedStyle(el),o={};for(let i=0;i<s.length;i++)o[s[i]]=s.getPropertyValue(s[i]);return o};
        const d=document.createElement("div");d.style.all="initial";document.body.append(d);const initial=read(d),native={};
        for(const key of ${JSON.stringify(CONTROLS)}){const [tag,type]=key.split(":"),el=document.createElement(tag);if(type)el.type=type;document.body.append(el);
          const all=read(el),own={};for(const name in all)if(all[name]!==initial[name])own[name]=all[name];native[key]=own;el.remove()}
        return {initial,native}})()`);
    } finally { win.destroy(); }
  })();
  initial.catch(() => { initial = null; });
  return initial;
}

const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const shift = (b, o) => ({ left: b.left + o.x, top: b.top + o.y, right: b.right + o.x, bottom: b.bottom + o.y });
/** A frame placed inside its parent's placement (main-viewport offset and visible clip). */
const nested = (base, frame) => {
  const clip = frame.clip ? shift(frame.clip, base.offset) : null;
  return { path: [...base.path, ...frame.path], offset: { x: base.offset.x + frame.offset.x, y: base.offset.y + frame.offset.y },
    clip: clip && base.clip ? meet(base.clip, clip) : clip ?? base.clip };
};
/** A page served from this machine or the LAN (an App output, a dev server) may show the same network's files. */
function localPage(origins) {
  return [...origins].every(origin => {
    try {
      const host = new URL(origin).hostname.replace(/^\[|\]$/gu, "");
      return host === "localhost" || host.endsWith(".localhost") || (isIP(host) > 0 && privateAddress(host));
    } catch { return false; }
  });
}

/**
 * Bytes of one resource through the tab's own session (its cache and cookies); only what the page could load.
 * A source that is not a web tab (the App's own UI) brings its own reader.
 */
async function fetchAsset(tab, url, origins) {
  if (tab.fetchAsset) return tab.fetchAsset(url);
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const profile = tab.view.webContents.session;
    if (!origins.has(parsed.origin) && !localPage(origins) && !await guardUrl(url, profile, {}, false)) return null;
    appLog("DEBUG", "http.client", "snapshot.fetch", { url: parsed.origin });
    const response = await profile.fetch(url, { signal: AbortSignal.timeout(8000), credentials: "include" });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > ASSET_LIMIT) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length > ASSET_LIMIT ? null : { type: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), body };
  } catch { return null; }
}
function sniff(body, type) {
  const head = body.subarray(0, 16).toString("latin1");
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.slice(4, 12) === "ftypavif") return "image/avif";
  if (head.startsWith("wOF2")) return "font/woff2";
  if (head.startsWith("wOFF")) return "font/woff";
  if (head.startsWith("OTTO")) return "font/otf";
  if (head.startsWith("\x00\x01\x00\x00") || head.startsWith("true")) return "font/ttf";
  if (/^image\/(svg\+xml|x-icon|vnd\.microsoft\.icon|bmp)$/u.test(type) || /<svg[\s>]/u.test(body.subarray(0, 512).toString("utf8"))) return type.startsWith("image/") ? type : "image/svg+xml";
  return null;
}
async function inlineAll(tab, urls, origins, kind, chars = "") {
  const found = new Map(), queue = [...new Set(urls)];
  const work = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const asset = await fetchAsset(tab, url, origins), type = asset && sniff(asset.body, asset.type);
      if (!type || !(kind === "font" ? type.startsWith("font/") : type.startsWith("image/"))) continue;
      const subset = kind === "font" && tab.subsetFont;
      const body = subset ? await tab.subsetFont(asset.body, chars) : asset.body;
      found.set(url, `data:${subset ? "font/woff2" : type};base64,${body.toString("base64")}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  return found;
}

/** @font-face blocks of a stylesheet the page world could not read (a cross-origin font service). */
function parseFaces(text, base) {
  const faces = [];
  for (const block of text.matchAll(/@font-face\s*\{([^}]*)\}/giu)) {
    const face = { base };
    for (const part of block[1].split(/;(?=(?:[^"']|"[^"]*"|'[^']*')*$)/u)) {
      const colon = part.indexOf(":"); if (colon < 0) continue;
      const name = part.slice(0, colon).trim().toLowerCase(), value = part.slice(colon + 1).trim();
      const key = { "font-family": "family", src: "src", "font-weight": "weight", "font-style": "style", "font-stretch": "stretch", "unicode-range": "range", "font-feature-settings": "features" }[name];
      if (key) face[key] = key === "family" ? value.replace(/^["']|["']$/gu, "").toLowerCase() : value;
    }
    if (face.family && face.src) faces.push(face);
  }
  return faces;
}
const inRange = (range, chars) => !range || range.split(",").some(part => {
  const m = /u\+([0-9a-f?]+)(?:-([0-9a-f]+))?/iu.exec(part.trim()); if (!m) return true;
  const low = parseInt(m[1].replace(/\?/gu, "0"), 16), high = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/gu, "f"), 16);
  return chars.some(code => code >= low && code <= high);
});
/** The faces a copy needs: used families, the nearest weight per used style, ranges that cover its text. */
function neededFaces(faces, families, chars) {
  const codes = [...chars].map(char => char.codePointAt(0)), keep = new Set();
  const weightOf = face => (face.weight || "400").replace("normal", "400").replace("bold", "700").split(/\s+/u).map(Number);
  for (const [family, uses] of families) {
    const candidates = faces.filter(face => face.family === family && inRange(face.range, codes));
    for (const use of uses) {
      const [weight, italic] = use.split("|"), w = Number(weight) || 400;
      const styled = candidates.filter(face => /^(italic|oblique)/u.test(face.style ?? "") === (italic === "italic"));
      const pool = styled.length ? styled : candidates;
      const distance = face => { const [low, high = low] = weightOf(face); return w < low ? low - w : w > high ? w - high : 0; };
      const best = Math.min(...pool.map(distance));
      for (const face of pool) if (distance(face) === best) keep.add(face);
    }
  }
  return [...keep];
}
function faceSource(face) {
  const sources = [...face.src.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/giu)].map(m => ({ url: m[2], format: (m[3] ?? "").toLowerCase() }));
  // A variable font names its format with "-variations" ("woff2-variations"); it is the same container.
  const rank = format => ["woff2", "woff", "truetype", "opentype", ""].indexOf(format.replace(/-variations$/u, ""));
  const usable = sources.filter(source => rank(source.format) >= 0).sort((a, b) => rank(a.format) - rank(b.format))[0];
  try { return usable && new URL(usable.url, face.base).href; } catch { return null; }
}
async function fontCss(tab, parts, origins) {
  const families = new Map(), chars = new Set(), faces = [];
  for (const part of parts) {
    for (const [family, uses] of part.families) families.set(family, new Set([...families.get(family) ?? [], ...uses]));
    for (const char of part.chars) chars.add(char);
    faces.push(...part.fonts.faces);
  }
  const sheets = [...new Set(parts.flatMap(part => part.fonts.sheets))].slice(0, 12);
  for (const href of sheets) {
    const sheet = await fetchAsset(tab, href, origins);
    if (!sheet || sheet.body.length > SHEET_LIMIT) continue;
    faces.push(...parseFaces(sheet.body.toString("utf8"), href).filter(face => families.has(face.family)));
  }
  const needed = neededFaces(faces, families, [...chars]).map(face => ({ face, url: faceSource(face) })).filter(entry => entry.url);
  const data = await inlineAll(tab, needed.map(entry => entry.url), origins, "font", [...chars].join(""));
  let css = "", total = 0;
  for (const { face, url } of needed) {
    const src = data.get(url);
    if (!src || (total += src.length) > FONT_BUDGET) continue;
    css += `@font-face{font-family:"${face.family.replace(/["\\]/gu, "")}";src:url("${src}");font-display:block;` +
      ["weight", "style", "stretch", "range", "features"].map(key => face[key] ? `${{ weight: "font-weight", style: "font-style", stretch: "font-stretch", range: "unicode-range", features: "font-feature-settings" }[key]}:${face[key]};` : "").join("") + "}";
  }
  return css;
}

/** An island: the visible part of its box from the screen (filled fields masked), the rest transparent. */
async function islandImage(tab, island, at, masks) {
  const scale = tab.bounds?.scale ?? 1, bounds = tab.view.getBounds();
  const box = { left: island.rect.x + at.offset.x, top: island.rect.y + at.offset.y, right: island.rect.x + at.offset.x + island.rect.width, bottom: island.rect.y + at.offset.y + island.rect.height };
  const width = Math.max(1, Math.round((box.right - box.left) * scale)), height = Math.max(1, Math.round((box.bottom - box.top) * scale));
  let shown = meet(box, { left: 0, top: 0, right: bounds.width / scale, bottom: bounds.height / scale });
  if (at.clip) shown = meet(shown, at.clip);
  if (shown.right - shown.left < 1 || shown.bottom - shown.top < 1 || width * height > 16e6) return CLEAR;
  const x = Math.floor(shown.left * scale), y = Math.floor(shown.top * scale);
  const image = await capturePage(tab, { x, y, width: Math.ceil(shown.right * scale) - x, height: Math.ceil(shown.bottom * scale) - y });
  if (image.isEmpty()) return CLEAR;
  const piece = nativeImage.createFromBuffer(image.toPNG()), size = piece.getSize(), source = piece.toBitmap();
  const pixels = Buffer.alloc(width * height * 4);
  const dx = Math.round((shown.left - box.left) * scale), dy = Math.round((shown.top - box.top) * scale);
  for (let row = 0; row < size.height && row + dy < height; row++) {
    const length = Math.min(size.width, width - dx) * 4;
    if (length > 0) source.copy(pixels, ((row + dy) * width + dx) * 4, row * size.width * 4, row * size.width * 4 + length);
  }
  for (const mask of masks) {
    const left = Math.max(0, Math.floor((mask.left - box.left) * scale)), right = Math.min(width, Math.ceil((mask.right - box.left) * scale));
    const top = Math.max(0, Math.floor((mask.top - box.top) * scale)), bottom = Math.min(height, Math.ceil((mask.bottom - box.top) * scale));
    for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) pixels.set(MASK, (row * width + col) * 4);
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toDataURL();
}

/**
 * The copy of one pick. `frame` is where an element pick lives ({path, offset, clip}); an area is a rectangle of
 * the main viewport. `run(path, args)` calls snapshot-page in that frame's world. Returns null when the page
 * changed, nothing could be read, or the copy exceeds SNAPSHOT_LIMIT (the crop stays the scrap's image).
 */
export async function snapshotPick({ tab, item, frame, area, run }) {
  const epoch = tab.epoch, url = tab.url, defaults = await initialValues();
  let calls = 0;
  const call = (path, args) => run(path, { ...args, ...defaults, prefix: `s${calls++}` });
  const top = { path: [], offset: { x: 0, y: 0 }, clip: null };
  const at = area ? top : frame;
  if (!at) return null;
  const root = area ? await call([], { op: "area", rect: area }) : await call(at.path, { op: "element", identity: item.identity });
  if (!root || root.tooLarge) return null;
  const parts = [{ data: root, at }];
  let html = root.html;
  const pending = root.frames.map(entry => ({ entry, base: at, depth: 1 }));
  while (pending.length) {
    const { entry, base, depth } = pending.shift(), place = nested(base, entry);
    const data = depth <= FRAME_DEPTH ? await call(place.path, { op: "frame", prune: entry.prune }).catch(() => null) : null;
    // A frame that cannot be read is one flat fill, like its crop.
    html = html.replace(entry.marker, () => data && !data.tooLarge ? data.html : "<div style=\"display:block;width:100%;height:100%;background:#d9d9d9\"></div>");
    if (!data || data.tooLarge) continue;
    parts.push({ data, at: place });
    pending.push(...data.frames.map(inner => ({ entry: inner, base: place, depth: depth + 1 })));
  }
  if (tab.epoch !== epoch || tab.url !== url) return null;
  const origins = new Set(parts.map(part => { try { return new URL(part.data.base).origin; } catch { return ""; } }));
  const tokens = new Map(), urls = [];
  for (const { data } of parts) for (const [source, token] of data.assets) { tokens.set(token, source); urls.push(source); }
  const images = await inlineAll(tab, urls, origins, "image");
  const masks = parts.flatMap(({ data, at: place }) => data.masks.map(mask => ({ left: mask.x + place.offset.x, top: mask.y + place.offset.y, right: mask.x + mask.width + place.offset.x, bottom: mask.y + mask.height + place.offset.y })));
  const islands = new Map();
  for (const { data, at: place } of parts) for (const island of data.islands) islands.set(island.token, await islandImage(tab, island, place, masks).catch(() => CLEAR));
  const fill = text => text.replace(/butler-asset:s\d+-i?\d+/gu, token => islands.get(token) ?? images.get(tokens.get(token)) ?? CLEAR);
  const css = (await fontCss(tab, parts.map(part => part.data), origins)) + parts.map(part => part.data.css).join("");
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<meta name="referrer" content="no-referrer"><base target="_blank"><style>html{background:${root.backdrop}}html,body{margin:0;padding:0}` +
    `body{position:relative;width:${root.width}px;height:${root.height}px;overflow:hidden}${RESET}{all:unset}${fill(css).replace(/</gu, "\\3c ")}</style></head>` +
    `<body>${fill(html)}</body></html>`;
  if (page.length > SNAPSHOT_LIMIT || tab.epoch !== epoch || tab.url !== url) return null;
  return { html: page, width: Math.round(root.width * 100) / 100, height: Math.round(root.height * 100) / 100, x: root.x + at.offset.x, y: root.y + at.offset.y };
}
