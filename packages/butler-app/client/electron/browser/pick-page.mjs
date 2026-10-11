/**
 * Element picking inside one frame's isolated world. Main serializes it with toString(), so it has no
 * imports or outer references. It only reads the DOM; nothing is inserted into the page.
 *
 * ops: "ladder" (the pick levels at a point, leaf first), "capture" (one level's geometry, text and
 * field masks), "area" (text, contained elements and masks inside a rectangle), "masks" (filled fields).
 * Coordinates are this frame's viewport CSS pixels; same-origin child frames are mapped in place and
 * cross-origin ones are returned as `descend`/`frames` for main to visit by window.frames index path.
 */
export function pickPage(args) {
  const MEDIA = "img,svg,canvas,video,picture,iframe,frame,embed,object";
  const CONTROL = "input,textarea,select,button,meter,progress";
  const MODAL = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const SVG = "http://www.w3.org/2000/svg";
  const ROLES = new Set(["dialog", "alertdialog", "article", "listitem", "row", "cell", "gridcell", "figure", "img", "button", "link", "navigation",
    "banner", "region", "list", "table", "menu", "menuitem", "tab", "tabpanel", "option", "listbox", "toolbar", "form", "search", "heading"]);
  const NOT_TEXT = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "range", "color", "file", "hidden"]);
  const state = globalThis.__butlerPick ??= { token: args.token, ids: new WeakMap(), refs: new Map() };
  const idOf = el => {
    let id = state.ids.get(el);
    if (!id) { id = state.refs.size + 1; state.ids.set(el, id); state.refs.set(id, new WeakRef(el)); }
    return id;
  };
  const style = (el, pseudo) => el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
  // Flat-tree parent: slots, then shadow hosts. Same-origin frame owners are crossed by callers.
  const parent = el => el.assignedSlot ?? el.parentElement ?? el.parentNode?.host ?? null;
  const box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const empty = b => !b || b.right - b.left < 0.5 || b.bottom - b.top < 0.5;
  const shift = (b, o) => ({ left: b.left + o.x, top: b.top + o.y, right: b.right + o.x, bottom: b.bottom + o.y });
  const out = b => ({ x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top });
  const within = (b, x, y) => x >= b.left && x < b.right && y >= b.top && y < b.bottom;
  const contained = (b, area) => b.left >= area.left - 1 && b.top >= area.top - 1 && b.right <= area.right + 1 && b.bottom <= area.bottom + 1;
  const size = b => (b.right - b.left) * (b.bottom - b.top);
  const viewport = doc => ({ left: 0, top: 0, right: doc.documentElement.clientWidth || doc.defaultView.innerWidth,
    bottom: doc.documentElement.clientHeight || doc.defaultView.innerHeight });
  const alpha = color => {
    if (!color || color === "transparent") return 0;
    const legacy = /rgba?\(([^)]*)\)/u.exec(color);
    const parts = legacy?.[1].split(/[\s,/]+/u).filter(Boolean);
    if (parts) return parts.length > 3 ? parseFloat(parts[3]) * (parts[3].endsWith("%") ? 0.01 : 1) : 1;
    const modern = /\/\s*([\d.]+)(%?)\s*\)/u.exec(color);
    return modern ? parseFloat(modern[1]) * (modern[2] ? 0.01 : 1) : 1;
  };

  /** The part of the viewport where el can show: overflow-clipping ancestors that contain it. */
  function clipOf(el) {
    const doc = el.ownerDocument;
    let clip = viewport(doc);
    const own = style(el).position;
    if (own === "fixed") return clip;
    let escaping = own === "absolute";
    for (let a = parent(el); a && a !== doc.documentElement && a !== doc.body; a = parent(a)) {
      const s = style(a), positioned = s.position !== "static" || s.transform !== "none";
      if ((!escaping || positioned) && (s.overflowX !== "visible" || s.overflowY !== "visible") && !["inline", "contents"].includes(s.display)) {
        const r = a.getBoundingClientRect(), left = r.left + a.clientLeft, top = r.top + a.clientTop;
        clip = meet(clip, { left: s.overflowX === "visible" ? -Infinity : left, top: s.overflowY === "visible" ? -Infinity : top,
          right: s.overflowX === "visible" ? Infinity : left + a.clientWidth, bottom: s.overflowY === "visible" ? Infinity : top + a.clientHeight });
      }
      if (s.position === "fixed") break;
      if (positioned) escaping = s.position === "absolute";
    }
    return clip;
  }
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return null;
    const b = meet(box(r), clipOf(el));
    return empty(b) ? null : b;
  };
  const isSvg = el => el.namespaceURI === SVG;
  /** Paints its own box: media, controls, a background, border or shadow. */
  function boxPaints(el) {
    if (el.matches(`${MEDIA},${CONTROL},hr`) || isSvg(el)) return true;
    const s = style(el);
    if (alpha(s.backgroundColor) > 0.02 || s.backgroundImage !== "none" || s.boxShadow !== "none" || (s.backdropFilter ?? "none") !== "none") return true;
    return ["Top", "Right", "Bottom", "Left"].some(side => parseFloat(s[`border${side}Width`]) > 0 &&
      !["none", "hidden"].includes(s[`border${side}Style`]) && alpha(s[`border${side}Color`]) > 0.02);
  }
  /** Shows nothing of its own at the point: a transparent overlay, shield or stretched link. */
  function seeThrough(el, x, y) {
    if (Number(style(el).opacity) === 0) return true;
    if (boxPaints(el)) return false;
    for (const pseudo of ["::before", "::after"]) {
      const p = style(el, pseudo);
      if (!["none", "normal", '""'].includes(p.content) || alpha(p.backgroundColor) > 0.02 || p.backgroundImage !== "none") return false;
    }
    const range = el.ownerDocument.createRange();
    for (const node of el.childNodes) if (node.nodeType === 3 && node.data.trim()) {
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (within(box(r), x, y)) return false;
    }
    return true;
  }
  /** Topmost element that shows something at the point; overlays that hide other content are skipped. */
  function leafAt(root, x, y) {
    const stack = root.elementsFromPoint(x, y).filter(el => root.nodeType === 9 || el.getRootNode() === root);
    for (let i = 0; i < stack.length; i++) {
      if (seeThrough(stack[i], x, y) && stack.slice(i + 1).some(below => !below.contains(stack[i]))) continue;
      return stack[i];
    }
    return null;
  }
  /** pointer-events:none content is invisible to hit-testing; find it geometrically under the hit. */
  function refine(el, x, y) {
    for (let depth = 0; depth < 64; depth++) {
      let next = null;
      for (const child of [...el.shadowRoot?.children ?? [], ...el.children]) {
        const s = style(child);
        if (s.pointerEvents !== "none" || s.display === "none" || s.visibility !== "visible") continue;
        const r = child.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && within(box(r), x, y)) next = child;
      }
      if (!next) return el;
      el = next;
    }
    return el;
  }
  function deepLeaf(doc, x, y) {
    let el = leafAt(doc, x, y);
    while (el?.shadowRoot) {
      const inner = leafAt(el.shadowRoot, x, y);
      if (!inner) break;
      el = inner;
    }
    return el && refine(el, x, y);
  }
  const chain = leaf => {
    const levels = [], doc = leaf.ownerDocument;
    for (let el = leaf; el && el !== doc.body && el !== doc.documentElement; el = parent(el)) {
      const b = visible(el);
      if (b) levels.push({ el, b });
    }
    return levels;
  };
  /** Too fine to be what a person means by default: SVG parts, inline text runs, tiny boxes. */
  const weak = (el, b) => (isSvg(el) && !(el.localName === "svg" && !(parent(el) && isSvg(parent(el)))))
    || (!el.matches(`${MEDIA},${CONTROL}`) && style(el).display === "inline")
    || (b.right - b.left < 24 && b.bottom - b.top < 24);
  function defaultIndex(levels) {
    let index = levels.findIndex(level => !weak(level.el, level.b));
    if (index < 0) return 0;
    if (levels[index].el.matches("img,picture,video,canvas,svg")) {
      const figure = levels.findIndex((level, i) => i > index && i <= index + 2 && (level.el.localName === "figure" || level.el.getAttribute("role") === "figure"));
      if (figure > 0) index = figure;
    }
    return index;
  }
  function isModal(el, screen) {
    if (el.localName === "dialog") { try { return el.matches(":modal"); } catch { return false; } }
    if (el.getAttribute("aria-modal") === "true") return true;
    for (let a = el; a; a = parent(a)) if (style(a).position === "fixed") return size(box(a.getBoundingClientRect())) >= screen * 0.85;
    return false;
  }
  /** A full-viewport layer under the pointer while a modal is open is its dimmed backdrop: it stands for the modal. */
  function backdropModal(doc, hovered, levels) {
    const screen = size(viewport(doc));
    if (hovered && size(hovered.b) < screen * 0.85) return null;
    // The document and the shadow roots the pointer is inside (a web-component dialog keeps its panel there).
    const roots = [doc, ...levels.map(level => level.el.shadowRoot).filter(Boolean)];
    const modal = roots.flatMap(root => [...root.querySelectorAll(MODAL)]).filter(el => isModal(el, screen) && visible(el)).at(-1);
    if (!modal || size(visible(modal)) >= screen * 0.85) return null;
    for (let el = hovered?.el; el; el = parent(el)) if (el === modal) return null;
    return modal;
  }
  function frameInfo(frame) {
    const r = frame.getBoundingClientRect(), s = style(frame);
    const left = r.left + frame.clientLeft + parseFloat(s.paddingLeft), top = r.top + frame.clientTop + parseFloat(s.paddingTop);
    const content = { left, top, right: left + frame.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
      bottom: top + frame.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) };
    return { offset: { x: left, y: top }, clip: meet(content, clipOf(frame)) };
  }
  const childDocument = frame => { try { return frame.contentDocument?.documentElement ? frame.contentDocument : null; } catch { return null; } };
  /** window.frames index path from this world's window; main maps it onto WebFrameMain.frames. */
  function framePath(win) {
    const path = [];
    for (let w = win; w && w !== window; w = w.parent) {
      const siblings = w.parent.frames;
      let index = 0;
      while (index < siblings.length && siblings[index] !== w) index++;
      if (index === siblings.length) return null;
      path.unshift(index);
    }
    return path;
  }
  const mapFrame = (descend, info) => descend && { ...descend, offset: { x: descend.offset.x + info.offset.x, y: descend.offset.y + info.offset.y },
    clip: meet(shift(descend.clip, info.offset), info.clip) };
  function analyze(doc, x, y) {
    let leaf = deepLeaf(doc, x, y);
    if (leaf === doc.body || leaf === doc.documentElement) leaf = null;
    let levels = leaf ? chain(leaf) : [], index = defaultIndex(levels);
    const modal = backdropModal(doc, levels[index], levels);
    if (modal) { levels = chain(modal); index = 0; }
    const frame = levels[0]?.el;
    if (!frame?.matches("iframe,frame")) return { levels, index };
    const info = frameInfo(frame);
    if (!within(info.clip, x, y)) return { levels, index };
    const child = childDocument(frame);
    if (!child) {
      const path = framePath(frame.contentWindow);
      return { levels, index, descend: path && { path, x: x - info.offset.x, y: y - info.offset.y, offset: info.offset, clip: info.clip } };
    }
    const inner = analyze(child, x - info.offset.x, y - info.offset.y);
    const mapped = inner.levels.map(level => ({ el: level.el, b: meet(shift(level.b, info.offset), info.clip) })).filter(level => !empty(level.b));
    const chosen = inner.levels[inner.index]?.el, at = mapped.findIndex(level => level.el === chosen);
    return { levels: [...mapped, ...levels], index: at >= 0 ? at : mapped.length + index, descend: mapFrame(inner.descend, info) };
  }
  const nameOf = el => ROLES.has(el.getAttribute("role")) ? el.getAttribute("role") : el.localName;
  const secretField = f => f.localName === "textarea" ? f.value !== "" : f.localName === "input" && !NOT_TEXT.has(f.type) && (f.type === "password" || f.value !== "");
  /** Filled text fields (any frame, any open shadow root) become flat masks; cross-origin frames go to main. */
  function fieldsIn(root, offset, clip, masks, frames) {
    const scan = el => {
      if (el.matches("input,textarea") && secretField(el)) {
        const b = visible(el), m = b && meet(shift(b, offset), clip);
        if (m && !empty(m)) masks.push(m);
      }
      if (el.shadowRoot) fieldsIn(el.shadowRoot, offset, clip, masks, frames);
      if (!el.matches("iframe,frame")) return;
      const info = frameInfo(el), at = { x: offset.x + info.offset.x, y: offset.y + info.offset.y }, inner = meet(clip, shift(info.clip, offset));
      if (empty(inner)) return;
      const child = childDocument(el);
      if (child) fieldsIn(child, at, inner, masks, frames);
      else { const path = framePath(el.contentWindow); if (path) frames.push({ path, offset: at, clip: inner }); }
    };
    if (root.nodeType === 1) scan(root);
    for (const el of root.querySelectorAll("*")) scan(el);
  }
  /** Text runs and painted boxes: a block's empty width is not part of its crop. */
  function contentBox(el, b) {
    let found = null;
    const add = r => { if (r.width > 0 && r.height > 0) found = found ? { left: Math.min(found.left, r.left), top: Math.min(found.top, r.top),
      right: Math.max(found.right, r.right), bottom: Math.max(found.bottom, r.bottom) } : box(r); };
    const range = el.ownerDocument.createRange();
    const visit = node => {
      if (node.nodeType === 3) {
        if (node.data.trim() && style(node.parentElement).visibility === "visible") { range.selectNodeContents(node); for (const r of range.getClientRects()) add(r); }
        return;
      }
      if (node.nodeType !== 1) return;
      const s = style(node);
      if (s.display === "none" || Number(s.opacity) === 0) return;
      if (node !== el && s.visibility === "visible" && boxPaints(node)) { add(node.getBoundingClientRect()); return; }
      for (const child of node.shadowRoot?.childNodes ?? []) visit(child);
      for (const child of node.childNodes) visit(child);
    };
    visit(el);
    return found ? meet(b, found) : b;
  }
  const textOf = el => el.localName === "img" ? el.alt ?? "" : el.matches("input,textarea,select") ? "" : (el.innerText ?? el.textContent ?? "");
  function titleOf(el, text) {
    const root = el.getRootNode();
    const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/u).map(id => id && root.getElementById?.(id)?.innerText).filter(Boolean).join(" ");
    const label = el.getAttribute("aria-label") || labelled || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder");
    const heading = !label && el.querySelector?.("h1,h2,h3,h4,h5,h6,[role=heading]");
    const line = String(label || heading?.innerText || text).split("\n").map(part => part.trim()).find(Boolean) || el.localName;
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  }
  function topOffset(doc) {
    let x = 0, y = 0;
    for (; doc !== document; doc = doc.defaultView.frameElement.ownerDocument) {
      const info = frameInfo(doc.defaultView.frameElement); x += info.offset.x; y += info.offset.y;
    }
    return { x, y };
  }
  /** Geometry from el's document to this world's document, through same-origin frame owners. */
  function toTop(el, boxes) {
    let doc = el.ownerDocument;
    while (doc !== document) {
      const owner = doc.defaultView.frameElement;
      if (!owner) return null;
      const info = frameInfo(owner);
      boxes = boxes.map(b => b && meet(shift(b, info.offset), info.clip));
      doc = owner.ownerDocument;
    }
    return boxes;
  }

  if (args.op === "ladder") {
    const result = analyze(document, args.x, args.y);
    return { index: result.index, descend: result.descend,
      levels: result.levels.map(level => ({ id: idOf(level.el), identity: `${state.token}:${idOf(level.el)}`, rect: out(level.b), name: nameOf(level.el) })) };
  }
  if (args.op === "capture") {
    const el = state.refs.get(args.id)?.deref();
    const b = el?.isConnected ? visible(el) : null;
    if (!b) return null;
    const crop = boxPaints(el) ? b : contentBox(el, b), masks = [], frames = [];
    fieldsIn(el, { x: 0, y: 0 }, crop, masks, frames);
    const mapped = toTop(el, [b, crop, ...masks]);
    if (!mapped || empty(mapped[0]) || empty(mapped[1])) return null;
    const [rect, cropRect, ...fields] = mapped, text = textOf(el);
    const origin = topOffset(el.ownerDocument);
    return { rect: out(rect), cropRect: out(cropRect), masks: fields.filter(m => !empty(m)).map(out), text, title: titleOf(el, text), tag: el.localName,
      identity: `${state.token}:${idOf(el)}`, frames: frames.map(frame => ({ path: frame.path, offset: { x: frame.offset.x + origin.x, y: frame.offset.y + origin.y },
        clip: toTop(el, [frame.clip])[0] })).filter(frame => !empty(frame.clip)) };
  }
  if (args.op === "masks") {
    const masks = [], frames = [];
    fieldsIn(document, { x: 0, y: 0 }, viewport(document), masks, frames);
    return { masks: masks.map(out), frames };
  }
  if (args.op === "area") {
    const area = { left: args.rect.x, top: args.rect.y, right: args.rect.x + args.rect.width, bottom: args.rect.y + args.rect.height };
    const pieces = [], found = [], masks = [], frames = [];
    const visit = (node, offset, clipArea, inside) => {
      if (node.nodeType === 3) {
        if (!node.data.trim()) return;
        const range = node.ownerDocument.createRange(); range.selectNodeContents(node);
        const rects = [...range.getClientRects()].map(r => shift(box(r), offset)).filter(r => !empty(r));
        // Geometry first: clip and style reads only for text that reaches the area.
        if (!rects.some(r => !empty(meet(r, clipArea))) || style(node.parentElement).visibility !== "visible") return;
        const clip = meet(shift(clipOf(node.parentElement), offset), clipArea);
        if (!rects.some(r => !empty(meet(r, clip)))) return;
        if (rects.every(r => contained(r, clip))) { pieces.push({ text: node.data, first: rects[0], last: rects.at(-1) }); return; }
        let text = "", first = null, last = null;
        for (let i = 0; i < node.data.length; i++) {
          range.setStart(node, i); range.setEnd(node, i + 1);
          const r = shift(box(range.getBoundingClientRect()), offset);
          if (r.right - r.left > 0 && within(clip, (r.left + r.right) / 2, (r.top + r.bottom) / 2)) { text += node.data[i]; first ??= r; last = r; }
          else if (text && /\s/u.test(node.data[i])) text += " ";
        }
        if (text.trim()) pieces.push({ text, first, last });
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node, s = style(el);
      if (s.display === "none" || Number(s.opacity) === 0) return;
      const r = shift(box(el.getBoundingClientRect()), offset);
      if ((s.overflowX !== "visible" || s.overflowY !== "visible") && empty(meet(r, clipArea))) return;
      const b = s.visibility === "visible" && !empty(meet(r, clipArea)) ? visible(el) : null, at = b && shift(b, offset);
      if (!inside && at && contained(at, clipArea) && !weak(el, b) && (boxPaints(el) || el.innerText?.trim())) {
        found.push(el); inside = true;
      }
      if (el.matches("input,textarea") && secretField(el) && at && !empty(meet(at, clipArea))) masks.push(meet(at, clipArea));
      if (el.matches("iframe,frame")) {
        const info = frameInfo(el), next = { x: offset.x + info.offset.x, y: offset.y + info.offset.y }, inner = meet(clipArea, shift(info.clip, offset));
        if (empty(inner)) return;
        const child = childDocument(el);
        if (child) visit(child.documentElement, next, inner, inside);
        else { const path = framePath(el.contentWindow); if (path) frames.push({ path, offset: next, clip: inner }); }
        return;
      }
      if (el.matches("input,textarea,select,script,style,template")) return;
      for (const child of el.shadowRoot?.childNodes ?? []) visit(child, offset, clipArea, inside);
      for (const child of el.childNodes) visit(child, offset, clipArea, inside);
    };
    visit(document.documentElement, { x: 0, y: 0 }, area, false);
    let text = "", last = null;
    for (const piece of pieces) {
      const run = piece.text.replace(/\s+/gu, " ");
      if (last) {
        const sameLine = piece.first.top < last.bottom - 2 && piece.first.bottom > last.top + 2 && piece.first.left >= last.right - 1;
        if (!sameLine) text = `${text.trimEnd()}\n`;
        else if (piece.first.left - last.right > 4 && !/\s$/u.test(text) && !/^\s/u.test(run)) text += " ";
      }
      text += last && text.endsWith("\n") ? run.trimStart() : last ? run : run.trimStart();
      last = piece.last;
    }
    const contains = found.map(el => ({ tag: nameOf(el), title: titleOf(el, textOf(el)) }));
    return { text: text.trim(), title: contains.find(item => /^(h[1-6]|heading)$/u.test(item.tag))?.title ?? text.trim().split("\n")[0] ?? "", contains, masks: masks.map(out), frames };
  }
  return null;
}
