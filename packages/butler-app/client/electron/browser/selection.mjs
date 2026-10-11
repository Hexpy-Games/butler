import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { savePickedImages, copyPickedText } from "./selection-actions.mjs";
import { isPickShortcut } from "../butler-platform/browser-shortcuts.mjs";
import { nativeWorldOf } from "./native-worlds.mjs";
import { pickPage } from "./pick-page.mjs";

/** DOM content is read in isolated worlds (pick-page.mjs), never inserted into the page. */
const PAGE = pickPage.toString();
const MAIN_WORLD = 1004, FRAME_WORLD = 9001;
const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const shift = (b, o) => ({ left: b.left + o.x, top: b.top + o.y, right: b.right + o.x, bottom: b.bottom + o.y });
const edges = r => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
const rectOf = b => b.right - b.left >= 0.5 && b.bottom - b.top >= 0.5 ? { x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top } : null;
/** A frame-local rect in main-viewport CSS pixels, inside every owning iframe's visible box. */
const place = (rect, frame) => { const b = shift(edges(rect), frame.offset); return rectOf(frame.clip ? meet(b, frame.clip) : b); };
const sameBox = (a, b) => ["left", "top", "right", "bottom"].every(key => Math.abs(edges(a)[key] - edges(b)[key]) <= 2);
const inside = (rect, point) => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
const nested = (base, frame) => ({ path: [...base.path, ...frame.path], offset: { x: base.offset.x + frame.offset.x, y: base.offset.y + frame.offset.y },
  clip: base.clip ? meet(base.clip, shift(frame.clip, base.offset)) : shift(frame.clip, base.offset) });
const TOP = { path: [], offset: { x: 0, y: 0 }, clip: null };
const GENERIC = new Set(["div", "span"]);
/** One opaque neutral pixel (BGRA): a filled field's box in a crop. */
const MASK = Buffer.from([0xd9, 0xd9, 0xd9, 0xff]);

/** Runs pick-page in the main frame's pick world, or a subframe's preload world by window.frames path. */
async function runIn(tab, path, args) {
  const code = `(${PAGE})(${JSON.stringify({ ...args, token: randomUUID() })})`;
  if (!path.length) return tab.view.webContents.executeJavaScriptInIsolatedWorld(MAIN_WORLD, [{ code }]);
  let frame = tab.view.webContents.mainFrame;
  for (const index of path) frame = frame?.frames[index];
  const world = frame && nativeWorldOf(tab, frame);
  return world ? world.executeJavaScriptInIsolatedWorld(FRAME_WORLD, [{ code }]).catch(() => null) : null;
}
/** A frame's current placement, resolving each window.frames step in its parent's world. */
async function frameAt(tab, path) {
  let frame = TOP;
  for (let step = 0; step < path.length; step++) {
    const box = await runIn(tab, path.slice(0, step), { op: "frame", index: path[step] }).catch(() => null);
    if (!box) return null;
    frame = nested(frame, { path: [path[step]], offset: box.offset, clip: box.clip });
  }
  return frame;
}
/** Filled fields never reach a crop. A frame that cannot be read is masked whole. */
async function frameMasks(tab, base, frames) {
  const masks = [];
  for (const frame of frames ?? []) {
    const at = nested(base, frame), found = await runIn(tab, at.path, { op: "masks" }).catch(() => null);
    if (!found) { const whole = rectOf(at.clip); if (whole) masks.push(whole); continue; }
    masks.push(...found.masks.map(mask => place(mask, at)).filter(Boolean), ...await frameMasks(tab, at, found.frames));
  }
  return masks;
}
function maskImage(image, rect, masks) {
  // A PNG round trip yields one device-pixel representation to edit.
  const plain = nativeImage.createFromBuffer(image.toPNG()), { width, height } = plain.getSize(), pixels = Buffer.from(plain.toBitmap());
  const fx = width / rect.width, fy = height / rect.height;
  for (const mask of masks) {
    const left = Math.max(0, Math.floor((mask.x - rect.x) * fx)), right = Math.min(width, Math.ceil((mask.x + mask.width - rect.x) * fx));
    const top = Math.max(0, Math.floor((mask.y - rect.y) * fy)), bottom = Math.min(height, Math.ceil((mask.y + mask.height - rect.y) * fy));
    for (let y = top; y < bottom; y++) pixels.fill(MASK, (y * width + left) * 4, (y * width + right) * 4);
  }
  return nativeImage.createFromBitmap(pixels, { width, height });
}

export class BrowserSelection {
  constructor(browser) {
    this.browser = browser;
    // The frame each element pick lives in; areas have none and never outlive their view.
    this.anchors = new WeakMap();
  }
  /** Picks follow their document: a new document clears them, an in-page change re-anchors them. */
  watch(tab) {
    const contents = tab.view.webContents;
    contents.on("did-navigate", () => this.navigated(tab, false));
    contents.on("did-navigate-in-page", () => this.navigated(tab, true));
    contents.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => { if (!isMainFrame) this.navigated(tab, true); });
  }
  navigated(tab, sameDocument) {
    this.clearHover(tab); this.preferred = null;
    if (!tab.selections?.length) return;
    if (!sameDocument) {
      tab.selections = []; this.browser.publish(); this.browser.pointer.sync(tab); return;
    }
    tab.reanchoring = (tab.reanchoring ?? Promise.resolve()).then(() => this.reanchor(tab)).catch(() => this.browser.pointer.inputFailed());
    return tab.reanchoring;
  }
  /** Moves each element pick's outline to where its element now is; drops picks whose element is gone. */
  async reanchor(tab) {
    const gone = new Set();
    for (const item of [...tab.selections ?? []]) {
      const stored = this.anchors.get(item);
      // A cross-origin frame can move with its parent's layout: place it again from its owners.
      const frame = stored?.path.length ? await frameAt(tab, stored.path) : stored;
      if (frame) this.anchors.set(item, frame);
      const found = frame && await runIn(tab, frame.path, { op: "anchor", identity: item.identity }).catch(() => null);
      if (!found || found.gone) { gone.add(item); continue; }
      const rect = found.rect && place(found.rect, frame);
      if (!rect) continue;
      const dx = rect.x - item.rect.x, dy = rect.y - item.rect.y;
      item.cropRect = { ...item.cropRect, x: item.cropRect.x + dx, y: item.cropRect.y + dy };
      item.rect = rect;
    }
    if (gone.size) tab.selections = (tab.selections ?? []).filter(item => !gone.has(item));
    this.browser.publish(); this.browser.pointer.sync(tab);
  }
  shortcut(input) {
    if (!isPickShortcut(input)) return false;
    this.mode(this.browser.activeId, true); return true;
  }
  mode(id, value) {
    const tab = this.browser.tabs.get(id);
    if (!tab?.url || !tab.view) return;
    this.chrome = null;
    if (value && !this.browser.pointer.acceptInput(tab, true)) return;
    tab.picking = value === true;
    this.preferred = null;
    this.cancelDrag(); this.clearHover(tab);
    this.browser.publish();
    if (tab.picking) this.browser.pointer.view?.webContents.focus();
  }
  clear(id) {
    const tab = this.browser.tabs.get(id); if (!tab) return;
    tab.selections = []; this.browser.publish();
  }
  result(tab, session) {
    const elements = (tab.selections ?? []).map(item => {
      const { ref, ...data } = item;
      // A move/navigation invalidates actable refs, without destroying the saved picks.
      return { ...data, ...(ref && ref.owner === `conversation:${session}` && ref.epoch === tab.epoch ? { ref: ref.id, observation: ref.observation } : {}) };
    });
    return { status: "ok", tab: tab.id, untrusted_content: { kind: "web_page_data", elements } };
  }
  clearHover(tab) {
    if (tab) tab.pickHover = null; this.hoverInput = null; this.hoverRevision = (this.hoverRevision ?? 0) + 1;
  }
  /** Pick levels under a view point, leaf first, across open shadow roots and every frame. */
  async probe(tab, input) {
    const scale = tab.bounds?.scale ?? 1, found = [];
    let frame = TOP, at = { x: input.x / scale, y: input.y / scale };
    for (let depth = 0; depth < 16; depth++) {
      const result = await runIn(tab, frame.path, { op: "ladder", x: at.x, y: at.y });
      if (!result) break;
      found.unshift({ result, frame });
      if (!result.descend) break;
      at = { x: result.descend.x, y: result.descend.y };
      frame = nested(frame, result.descend);
    }
    const levels = [];
    let chosen = null;
    for (const { result, frame } of found) {
      const placed = result.levels.map(level => { const rect = place(level.rect, frame); return rect && { ...level, rect, frame }; }).filter(Boolean);
      if (chosen === null && placed.length) chosen = result.levels[result.index]?.identity ?? placed[0].identity;
      // A wrapper with its child's box is one level: the outer element, unless only the inner one has meaning (div > img).
      for (const level of placed) {
        const last = levels.at(-1);
        if (!last || !sameBox(last.rect, level.rect)) { levels.push(level); continue; }
        const keep = GENERIC.has(level.name) && !GENERIC.has(last.name) ? last : level, drop = keep === last ? level : last;
        if (chosen === drop.identity) chosen = keep.identity;
        levels[levels.length - 1] = keep;
      }
    }
    if (this.preferred && !levels.some(level => level.identity === this.preferred)) this.preferred = null;
    const index = Math.max(0, levels.findIndex(level => level.identity === (this.preferred ?? chosen)));
    return { levels, index };
  }
  label(levels, index) {
    const level = levels[index], arrows = `${index < levels.length - 1 ? "↑" : ""}${index > 0 ? "↓" : ""}`;
    return { rect: level.rect, label: [level.name, `${Math.round(level.rect.width)} × ${Math.round(level.rect.height)}`, ...(arrows ? [arrows] : [])].join(" · ") };
  }
  show(tab, ladder) {
    tab.pickHover = ladder?.levels.length ? { levels: ladder.levels, index: ladder.index, ...this.label(ladder.levels, ladder.index) } : null;
  }
  async hoverAt(tab, input) {
    const ladder = await this.probe(tab, input);
    this.show(tab, ladder); return ladder;
  }
  /** ↑ (+1) widens to the enclosing level, ↓ (-1) narrows back toward the pointer. */
  step(tab, delta) {
    const hover = tab?.pickHover;
    if (!tab?.picking || !hover?.levels || this.down) return;
    const index = Math.max(0, Math.min(hover.levels.length - 1, hover.index + delta));
    if (index === hover.index) return;
    this.preferred = hover.levels[index].identity;
    Object.assign(hover, { index, ...this.label(hover.levels, index) });
    this.browser.pointer.sync(tab);
  }
  hover(tab, input) {
    this.hoverRevision = (this.hoverRevision ?? 0) + 1;
    this.hoverInput = { tab, input, epoch: tab.epoch, revision: this.hoverRevision };
    if (this.hoverPending) return;
    this.hoverPending = true;
    void this.updateHover().catch(() => this.browser.pointer.inputFailed()).finally(() => { this.hoverPending = false; });
  }
  async updateHover() {
    while (this.hoverInput) {
      const { tab, input, epoch, revision } = this.hoverInput; this.hoverInput = null;
      const ladder = await this.probe(tab, input).catch(() => null);
      if (revision !== this.hoverRevision || !tab.picking || tab.epoch !== epoch || this.browser.activeId !== tab.id || this.down) continue;
      this.show(tab, ladder);
      this.browser.pointer.sync(tab);
    }
  }
  async crop(tab, cropRect, masks) {
    const scale = tab.bounds?.scale ?? 1, x = Math.floor(cropRect.x * scale), y = Math.floor(cropRect.y * scale);
    const rect = { x, y, width: Math.ceil((cropRect.x + cropRect.width) * scale) - x, height: Math.ceil((cropRect.y + cropRect.height) * scale) - y };
    let image = await tab.view.webContents.capturePage(rect, { stayHidden: true });
    if (image.isEmpty()) return null;
    if (masks.length) image = maskImage(image, rect, masks.map(mask => ({ x: mask.x * scale, y: mask.y * scale, width: mask.width * scale, height: mask.height * scale })));
    return `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
  }
  picked(tab, url, data) {
    const node = tab.observation?.nodes?.find(node => node.rect && Math.abs(node.rect.x - data.rect.x) < 1 && Math.abs(node.rect.y - data.rect.y) < 1);
    return { ...data, id: randomUUID(), tab: tab.id, url, site: new URL(url).host, capturedAt: new Date().toISOString(),
      ...(node ? { ref: { id: node.ref, observation: tab.observation.obs, epoch: tab.epoch, owner: tab.owner } } : {}) };
  }
  /** The hovered level at a point (the user's ↑/↓ choice when it is still under the pointer). */
  async hit(tab, input) {
    const epoch = tab.epoch, url = tab.url;
    const ladder = await this.probe(tab, input), level = ladder.levels[ladder.index];
    if (!level) return null;
    const data = await runIn(tab, level.frame.path, { op: "capture", id: level.id });
    const rect = data && place(data.rect, level.frame), cropRect = data && place(data.cropRect, level.frame);
    if (!rect || !cropRect) return null;
    const masks = [...data.masks.map(mask => place(mask, level.frame)).filter(Boolean), ...await frameMasks(tab, level.frame, data.frames)];
    const crop = await this.crop(tab, cropRect, masks);
    if (!crop || !this.browser.tabs.has(tab.id) || tab.epoch !== epoch || tab.url !== url) return null;
    const item = this.picked(tab, url, { title: data.title, text: data.text, tag: data.tag, rect, cropRect, identity: data.identity, crop });
    this.anchors.set(item, level.frame);
    return item;
  }
  /** Drag-rectangle capture: the crop, its text and the elements wholly inside it. */
  async area(tab, cssRect) {
    const epoch = tab.epoch, url = tab.url, bounds = tab.view.getBounds(), scale = tab.bounds?.scale ?? 1;
    const rect = rectOf(meet(edges(cssRect), { left: 0, top: 0, right: bounds.width / scale, bottom: bounds.height / scale }));
    if (!rect) return null;
    const main = await runIn(tab, [], { op: "area", rect });
    let text = main?.text ?? "";
    const contains = [...main?.contains ?? []], masks = (main?.masks ?? []).map(mask => place(mask, TOP)).filter(Boolean);
    const pending = (main?.frames ?? []).map(frame => nested(TOP, frame));
    while (pending.length) {
      const frame = pending.shift(), local = frame.clip && rectOf(shift(meet(edges(rect), frame.clip), { x: -frame.offset.x, y: -frame.offset.y }));
      const data = local && await runIn(tab, frame.path, { op: "area", rect: local }).catch(() => null);
      if (!data) { const whole = rectOf(frame.clip); if (whole) masks.push(whole); continue; }
      if (data.text) text = text ? `${text}\n${data.text}` : data.text;
      contains.push(...data.contains);
      masks.push(...data.masks.map(mask => place(mask, frame)).filter(Boolean));
      pending.push(...data.frames.map(inner => nested(frame, inner)));
    }
    const crop = await this.crop(tab, rect, masks);
    if (!crop || !this.browser.tabs.has(tab.id) || tab.epoch !== epoch || tab.url !== url) return null;
    const item = this.picked(tab, url, { title: (main?.title || text.split("\n")[0] || `${Math.round(rect.width)} × ${Math.round(rect.height)}`).slice(0, 200),
      text, tag: "area", rect, cropRect: rect, identity: `area:${randomUUID()}`, contains, crop });
    tab.selections = [...tab.selections ?? [], item];
    this.browser.publish();
    return item;
  }
  band(tab, start, input) {
    const scale = tab.bounds?.scale ?? 1;
    const left = Math.min(start.x, input.x) / scale, top = Math.min(start.y, input.y) / scale;
    const rect = { x: left, y: top, width: Math.abs(input.x - start.x) / scale, height: Math.abs(input.y - start.y) / scale };
    tab.pickHover = { rect, label: `${Math.round(rect.width)} × ${Math.round(rect.height)}` };
    this.browser.pointer.sync(tab);
    return rect;
  }
  mouse(tab, input) {
    if (!tab?.picking) return false;
    if (input.type === "mouseWheel") {
      // ⌥/Alt + wheel walks levels like ↑/↓; a plain wheel still scrolls the page.
      if (!input.modifiers?.includes("alt")) return false;
      this.wheel = (this.wheel ?? 0) + input.deltaY;
      if (Math.abs(this.wheel) >= 40) { this.step(tab, Math.sign(this.wheel)); this.wheel = 0; }
      return true;
    }
    if (!["mouseDown", "mouseMove", "mouseUp"].includes(input.type)) return false;
    if (input.type === "mouseMove" && !this.down) this.hover(tab, input);
    if (input.type === "mouseDown" && input.button === "left") {
      const scale = tab.bounds?.scale ?? 1, point = { x: input.x / scale, y: input.y / scale };
      const start = { x: input.x, y: input.y, input, epoch: tab.epoch, alt: input.modifiers?.includes("alt"),
        onPick: (tab.selections ?? []).some(item => inside(item.rect, point)) };
      this.down = start;
      void this.hit(tab, input).then(item => {
        start.item = item; start.ready = true;
        // A drag that began before the hit resolved: nothing pickable under the press means an area.
        if (start.moved && start.area === undefined) start.area = !item;
        if (start.area) this.areaDrag(tab, start);
        else this.settle(tab, start);
      }).catch(() => this.browser.pointer.inputFailed());
    } else if (this.down && ["mouseMove", "mouseUp"].includes(input.type)) {
      const start = this.down;
      start.input = input;
      if (!start.moved && Math.hypot(input.x - start.x, input.y - start.y) > 6) {
        start.moved = true;
        // ⌥/Alt-drag, or a drag from where nothing is pickable, draws an area instead of carrying a pick out.
        start.area = start.alt || (start.onPick ? false : start.ready ? !start.item : undefined);
      }
      start.ended = input.type === "mouseUp";
      if (start.area) this.areaDrag(tab, start);
      else if (start.area === false || !start.moved) this.settle(tab, start);
    }
    return true;
  }
  areaDrag(tab, start) {
    if (this.down !== start) return;
    const rect = this.band(tab, start, start.input);
    if (!start.ended) return;
    this.down = null; this.clearHover(tab); this.browser.pointer.sync(tab);
    void this.area(tab, rect).catch(() => this.browser.pointer.inputFailed());
  }
  settle(tab, start) {
    if (this.down !== start || start.area) return;
    // A drag from a kept pick carries the picks out as they are; the press point's level is not added.
    if (start.moved && start.onPick && tab.picking && tab.epoch === start.epoch && this.browser.activeId === tab.id) {
      this.down = null;
      this.drag(tab, start.input, "start");
      if (start.ended) this.drag(tab, start.input, "end");
      return;
    }
    if (!start.ready) return;
    if (!start.item || !tab.picking || tab.epoch !== start.epoch || this.browser.activeId !== tab.id) {
      this.down = null; return;
    }
    if (!start.moved && !start.ended) return;
    this.down = null;
    const prior = tab.selections ?? [], item = start.item;
    const exists = prior.some(p => this.same(p, item));
    tab.selections = exists ? (start.moved ? prior : prior.filter(p => !this.same(p, item))) : [...prior, item];
    this.browser.publish();
    if (start.moved) {
      this.drag(tab, start.input, "start");
      if (start.ended) this.drag(tab, start.input, "end");
    }
  }
  cancelDrag() {
    this.down = null;
    const tab = this.browser.tabs.get(this.dragTab);
    if (tab) this.drag(tab, { x: 0, y: 0 }, "cancel");
    this.dragTab = null;
  }
  same(a, b) { return a.url === b.url && a.identity === b.identity; }
  drag(tab, input, phase) {
    if (phase === "end" || phase === "cancel") this.dragTab = null;
    if (!tab?.selections?.length || !tab.view || tab.view.webContents.isDestroyed()) return;
    const bounds = tab.view.getBounds();
    if (phase === "start") this.dragTab = tab.id;
    this.browser.getWindow()?.webContents.send("butler-browser:element-drag", {
      phase, tab: tab.id, x: bounds.x + input.x, y: bounds.y + input.y,
      ...(phase === "start" ? { elements: this.result(tab, tab.owner.slice(13)).untrusted_content.elements } : {}),
    });
    if (phase === "end" || phase === "cancel") this.browser.sync(tab);
  }
  async command(op, id) {
    const tab = this.browser.tabs.get(id);
    if (!tab || tab.id !== this.browser.activeId) return;
    if (op === "save-image") return savePickedImages(this.browser, tab);
    if (op === "copy-text") return copyPickedText(this.browser, tab);
    if (op === "attach" || op === "scrap") this.browser.getWindow()?.webContents.send("butler-browser:selection-action", { op, elements: this.result(tab, tab.owner.slice(13)).untrusted_content.elements });
    else if (op === "clear") this.clear(id);
    else if (op === "finish") this.mode(id, false);
    else if (op === "cancel-drag") this.cancelDrag();
  }
}
