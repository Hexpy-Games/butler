/**
 * Scrap snapshots inside one frame's isolated world. Main serializes this with toString(), so it has no
 * imports or outer references. It only reads the DOM; nothing is inserted into the page.
 *
 * The copy is the flat tree (open shadow roots and slots flattened) with the computed styles it needs written
 * inline, so it renders like the page without the page's stylesheets. The viewer resets every element
 * (`all: unset`), so a property is written when its value differs from what the reset leaves: the parent's value
 * for an inherited property, the initial value otherwise. Scripts, handlers, form actions and live frames never
 * reach the copy; filled fields become the same flat fill a crop shows.
 *
 * ops: "element" (a pick by identity), "area" (a rectangle of this viewport), "frame" (this frame's viewport,
 * for the iframe box a parent left a marker in). Resources come back as tokens for main to inline. Cross-origin
 * frames come back as markers for main to fill from their own world. What cannot be read as DOM (a tainted canvas
 * or video, plugins, closed shadow roots) comes back as an island rectangle for main to crop from the screen.
 * Coordinates are this frame's viewport CSS pixels.
 */
export async function snapshotPage(args, collectFonts, inlineBlobs) {
  const SVG = "http://www.w3.org/2000/svg", MATH = "http://www.w3.org/1998/Math/MathML";
  const MASK = "#d9d9d9", CLEAR = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const MAX_NODES = 40000, MAX_CHARS = 12 * 1024 * 1024;
  const INHERITED = new Set(`color font-family font-size font-style font-weight font-stretch font-width font-kerning font-optical-sizing
    font-feature-settings font-variation-settings font-size-adjust font-palette font-language-override font-variant font-variant-ligatures
    font-variant-caps font-variant-numeric font-variant-east-asian font-variant-alternates font-variant-position font-variant-emoji
    font-synthesis font-synthesis-weight font-synthesis-style font-synthesis-small-caps font-synthesis-position line-height letter-spacing
    word-spacing text-align text-align-last text-indent text-transform text-shadow text-rendering text-justify text-wrap text-wrap-mode
    text-wrap-style text-spacing-trim text-autospace text-size-adjust -webkit-text-size-adjust text-underline-offset text-underline-position
    text-decoration-skip-ink text-emphasis-color text-emphasis-position text-emphasis-style text-orientation -webkit-text-orientation
    text-combine-upright white-space white-space-collapse word-break overflow-wrap word-wrap line-break -webkit-line-break hyphens
    hyphenate-character hyphenate-limit-chars -webkit-hyphenate-character tab-size direction writing-mode -webkit-writing-mode visibility
    list-style-image list-style-position list-style-type quotes border-collapse border-spacing -webkit-border-horizontal-spacing
    -webkit-border-vertical-spacing caption-side empty-cells orphans widows color-scheme accent-color forced-color-adjust print-color-adjust
    -webkit-print-color-adjust image-orientation image-rendering ruby-position ruby-align -webkit-text-fill-color -webkit-text-stroke-color
    -webkit-text-stroke-width -webkit-text-security -webkit-font-smoothing -webkit-locale -webkit-rtl-ordering -webkit-tap-highlight-color
    -webkit-highlight -webkit-box-direction dynamic-range-limit math-depth math-shift math-style paint-order fill fill-opacity fill-rule
    stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width clip-rule
    color-interpolation color-interpolation-filters color-rendering marker marker-start marker-mid marker-end shape-rendering text-anchor
    dominant-baseline glyph-orientation-vertical`.split(/\s+/u).filter(Boolean));
  // Interaction, animation and scroll state never belong to a still copy; logical longhands repeat the physical ones.
  const SKIP = /^(--|transition|animation|view-transition|scroll-|overscroll-|will-change|content-visibility|contain-intrinsic|container|anchor|position-anchor|position-try|position-visibility|timeline-scope|view-timeline|cursor|touch-action|user-select|-webkit-user-select|-webkit-user-drag|-webkit-user-modify|pointer-events|caret-|interactivity|-webkit-text-decorations-in-effect)/u;
  const LOGICAL = /(^|-)(block|inline)(-|$)|^border-(start|end)-(start|end)-radius$/u;
  const NAMES = Object.keys(args.initial).filter(name => !SKIP.test(name) && !LOGICAL.test(name));
  // Initial currentcolor: the reset resolves it to the element's own color.
  const CURRENT = new Set(NAMES.filter(name => name.endsWith("-color") && !INHERITED.has(name) && args.initial[name] === args.initial.color && !/^(flood|stop|lighting)-color$/u.test(name)));
  // A native control keeps the platform look only while its box (background, border) is the browser's own.
  const LOOK = /^(background-|border-(top|right|bottom|left)-(style|width|color)$)/u;
  const LAYOUT = ["display", "position", "float", "clear", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-style", "border-right-style",
    "border-bottom-style", "border-left-style", "top", "right", "bottom", "left", "flex-grow", "flex-shrink", "flex-basis", "align-self",
    "justify-self", "order", "grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end", "vertical-align", "font-size", "line-height"];
  const DROP = new Set(["script", "noscript", "template", "style", "link", "meta", "base", "title", "head", "param", "source", "track", "datalist", "map", "area"]);
  const ISLAND = new Set(["embed", "object", "applet", "portal", "fencedframe", "audio"]);
  const VOID = new Set(["br", "col", "hr", "img", "input", "wbr"]);
  const TABLE = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup"]);
  const TABLE_CHILD = new Set(["caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th"]);
  // Tags the HTML parser would close, move or read raw: their look comes from the inline styles anyway.
  const RENAME = { p: "div", form: "div", dialog: "div", pre: "div", listing: "div", xmp: "div", plaintext: "div", marquee: "div",
    html: "div", body: "div", slot: "span", frameset: "div", noembed: "div", noframes: "div", search: "div", selectedcontent: "span" };
  const ATTRS = ["alt", "title", "dir", "lang", "role", "colspan", "rowspan", "span", "abbr", "scope", "aria-label", "aria-level"];
  const NOT_TEXT = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "range", "color", "file", "hidden"]);
  const state = globalThis.__butlerPick;
  const prefix = String(args.prefix).replace(/[^a-z0-9]/giu, "");
  const out = { assets: new Map(), islands: [], frames: [], rules: [], families: new Map(), chars: new Set(), masks: [],
    refs: new Set(), ids: new Set(), roots: new Set([document]), nodes: 0 };

  const { noteFont, noteText, fontFaces } = collectFonts(out);
  const style = (el, pseudo) => el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
  const esc = text => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/\u00a0/gu, "&nbsp;");
  const quote = text => String(text).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
  const box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const shift = (b, o) => ({ left: b.left + o.x, top: b.top + o.y, right: b.right + o.x, bottom: b.bottom + o.y });
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const empty = b => !b || b.right - b.left < 0.5 || b.bottom - b.top < 0.5;
  const rect = b => ({ x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top });
  const px = value => parseFloat(value) || 0;
  const childDocument = frame => { try { return frame.contentDocument?.documentElement ? frame.contentDocument : null; } catch { return null; } };
  const grow = () => { if (++out.nodes > MAX_NODES) throw new Error("too_large"); };

  function elementOf(identity) {
    const split = String(identity).lastIndexOf(":");
    return state && identity.slice(0, split) === state.token ? state.refs.get(Number(identity.slice(split + 1)))?.deref() ?? null : null;
  }
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
  function frameInfo(frame) {
    const r = frame.getBoundingClientRect(), s = style(frame);
    const left = r.left + frame.clientLeft + px(s.paddingLeft), top = r.top + frame.clientTop + px(s.paddingTop);
    return { offset: { x: left, y: top }, content: { left, top, right: left + frame.clientWidth - px(s.paddingLeft) - px(s.paddingRight),
      bottom: top + frame.clientHeight - px(s.paddingTop) - px(s.paddingBottom) } };
  }
  /** The content box of el (where a replaced element paints), in this world's viewport. */
  function contentBox(el, ctx) {
    const r = el.getBoundingClientRect(), s = style(el);
    const b = { left: r.left + px(s.borderLeftWidth) + px(s.paddingLeft), top: r.top + px(s.borderTopWidth) + px(s.paddingTop),
      right: r.right - px(s.borderRightWidth) - px(s.paddingRight), bottom: r.bottom - px(s.borderBottomWidth) - px(s.paddingBottom) };
    return shift(b, ctx.offset);
  }

  /** A resource URL becomes a token main replaces with its bytes; data: stays as it is. */
  function asset(url) {
    if (!url) return CLEAR;
    if (url.startsWith("data:")) return url;
    if (!/^(https?|blob):/iu.test(url)) return CLEAR;
    let token = out.assets.get(url);
    if (!token) { token = `butler-asset:${prefix}-${out.assets.size}`; out.assets.set(url, token); }
    return token;
  }
  const local = url => { const hash = url.indexOf("#"); return hash >= 0 && (hash === 0 || url.slice(0, hash) === location.href.split("#")[0]) ? url.slice(hash + 1) : null; };
  const urls = value => value.replace(/url\("((?:[^"\\]|\\.)*)"\)/gu, (match, raw) => {
    if (raw.startsWith("data:")) return match;
    const url = raw.replace(/\\(.)/gu, "$1"), id = local(url);
    if (id !== null) { out.refs.add(id); return `url("#${raw.slice(raw.indexOf("#") + 1)}")`; }
    return `url("${asset(url)}")`;
  });
  /** Declarations the reset copy needs: every inherited value at a copy root, the differences elsewhere. */
  function declarations(cs, parent, names = NAMES) {
    let text = "";
    for (const name of names) {
      const value = cs.getPropertyValue(name);
      if (INHERITED.has(name)) { if (parent && parent.getPropertyValue(name) === value) continue; }
      else if (value === args.initial[name] || (CURRENT.has(name) && value === cs.color)) continue;
      text += `${name}:${value.includes("url(") ? urls(value) : value};`;
    }
    return text;
  }
  /** The browser's own defaults for a control drawn natively (its box untouched by the page), else null. */
  function nativeLook(el, cs) {
    const key = el.localName === "input" ? `input:${el.type}` : el.localName, defaults = args.native?.[key];
    if (!defaults || cs.appearance === "none") return null;
    for (const name of NAMES) if (LOOK.test(name) && cs.getPropertyValue(name) !== (defaults[name] ?? args.initial[name])) return null;
    return defaults;
  }
  /** A native control is not reset: everything but its box differs from the browser's defaults for that control. */
  function nativeDeclarations(cs, parent, defaults) {
    let text = "";
    for (const name of NAMES) {
      if (LOOK.test(name)) continue;
      const value = cs.getPropertyValue(name), own = defaults[name] ?? args.initial[name];
      if (value === own && (!INHERITED.has(name) || (parent && parent.getPropertyValue(name) === value))) continue;
      text += `${name}:${value.includes("url(") ? urls(value) : value};`;
    }
    return text;
  }
  function pseudoRules(el, cs, tag) {
    const rules = [];
    for (const pseudo of ["::before", "::after"]) {
      const ps = style(el, pseudo);
      if (!ps || ["none", "normal", ""].includes(ps.content) || ps.display === "none") continue;
      rules.push([pseudo, declarations(ps, cs)]);
      noteFont(ps); noteText(ps.content.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/giu, (_match, hex, char) =>
        hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char));
    }
    if (cs.display === "list-item") {
      const ms = style(el, "::marker"), names = ["color", "font-size", "font-weight", "font-family", "font-style"];
      const differs = names.filter(name => ms.getPropertyValue(name) !== cs.getPropertyValue(name));
      if (differs.length) rules.push(["::marker", differs.map(name => `${name}:${ms.getPropertyValue(name)};`).join("")]);
    }
    if ((tag === "input" || tag === "textarea") && el.placeholder && !el.value) {
      const ps = style(el, "::placeholder");
      rules.push(["::placeholder", `color:${ps.color};opacity:${ps.opacity};`]); noteText(el.placeholder);
    }
    if (/^(auto|scroll|hidden)$/u.test(cs.overflowX) || /^(auto|scroll|hidden)$/u.test(cs.overflowY)) {
      try { const bar = style(el, "::-webkit-scrollbar"); if (bar.display === "none" || bar.width === "0px") rules.push(["::-webkit-scrollbar", "display:none;"]); } catch { /* not exposed */ }
    }
    if (!rules.length) return "";
    const name = `${prefix}c${out.rules.length}`;
    out.rules.push(rules.map(([pseudo, body]) => `.${name}${pseudo}{${body}}`).join(""));
    return ` class="${name}"`;
  }

  /** A scrolled container shows its content moved by its scroll offset: children carry it as a translation. */
  function scrolled(el, cs) {
    if (el.localName === "html" || el.localName === "body" || (!el.scrollTop && !el.scrollLeft)) return null;
    if (cs.overflowX === "visible" && cs.overflowY === "visible") return null;
    return { x: el.scrollLeft, y: el.scrollTop };
  }
  function translated(cs, scroll) {
    if (!scroll) return "";
    const [x = "0px", y = "0px", z = ""] = cs.translate === "none" ? [] : cs.translate.split(" ");
    return `translate:calc(${x} - ${scroll.x}px) calc(${y} - ${scroll.y}px)${z ? ` ${z}` : ""};`;
  }
  function attributes(el, tag) {
    let text = "";
    for (const name of ATTRS) if (el.hasAttribute(name)) text += ` ${name}="${quote(el.getAttribute(name))}"`;
    if (/^h[1-6]$/u.test(el.localName)) text += ` role="heading" aria-level="${el.localName[1]}"`;
    if (tag === "a" && /^(https?|mailto):/iu.test(el.href ?? "")) text += ` href="${quote(el.href)}" rel="noopener noreferrer"`;
    if (tag === "li" && el.parentElement?.localName === "ol") text += ` value="${ordinal(el)}"`;
    if (tag === "details" && el.open) text += " open";
    if (tag === "button") text += ` type="button"${el.disabled ? " disabled" : ""}`;
    if (tag === "option" && el.selected) text += " selected";
    if (/^(option|optgroup|select|fieldset)$/u.test(tag) && el.disabled) text += " disabled";
    if (tag === "select" && el.multiple) text += ` multiple size="${quote(el.size)}"`;
    if (tag === "optgroup" && el.label) text += ` label="${quote(el.label)}"`;
    if (tag === "progress" || tag === "meter") for (const name of ["value", "max", "min", "low", "high", "optimum"]) if (el.hasAttribute(name)) text += ` ${name}="${quote(el.getAttribute(name))}"`;
    if (tag === "progress" && el.hasAttribute("value")) text += ` value="${quote(el.value)}"`;
    return text;
  }
  function ordinal(li) {
    const list = li.parentElement, items = [...list.children].filter(child => child.localName === "li");
    let n = list.hasAttribute("start") ? list.start : list.reversed ? items.length : 1;
    for (const item of items) {
      if (item.hasAttribute("value")) n = item.value;
      if (item === li) return n;
      n += list.reversed ? -1 : 1;
    }
    return n;
  }

  /** Flat-tree children: an open shadow root's content, a slot's assigned nodes (or its fallback). */
  function childrenOf(el) {
    if (el.shadowRoot) { out.roots.add(el.shadowRoot); return [...el.shadowRoot.childNodes]; }
    if (el.localName === "slot") { const assigned = el.assignedNodes(); return assigned.length ? assigned : [...el.childNodes]; }
    if (el.localName === "template") return [];
    return [...el.childNodes];
  }
  function visibleIn(el, ctx) {
    if (!ctx.prune) return true;
    const r = el.getBoundingClientRect();
    const reach = shift({ left: r.left, top: r.top, right: Math.max(r.right, r.left + el.scrollWidth), bottom: Math.max(r.bottom, r.top + el.scrollHeight) }, ctx.offset);
    return !empty(meet(reach, ctx.prune));
  }
  function island(el, cs, parentCs, ctx, extra = "") {
    const token = `butler-asset:${prefix}-i${out.islands.length}`;
    out.islands.push({ token, rect: rect(contentBox(el, ctx)) });
    return `<img alt="" src="${token}" style="${quote(declarations(cs, parentCs) + extra)}object-fit:fill;">`;
  }
  function masked(cs, parentCs) {
    // The same opaque neutral fill a crop gets: no value, no placeholder, no caret.
    return `<div style="${quote(declarations(cs, parentCs, LAYOUT))}display:${cs.display === "inline" ? "inline-block" : cs.display};font-family:${quote(cs.fontFamily)};border-radius:${cs.borderRadius};background:${MASK};border-style:solid;border-color:${MASK};color:transparent;">&#8203;</div>`;
  }
  function placeholder(el, cs, parentCs) {
    const tag = TABLE_CHILD.has(el.localName) ? el.localName : "div";
    return `<${tag} style="${quote(declarations(cs, parentCs, LAYOUT))}visibility:hidden;"></${tag}>`;
  }
  function secret(el) {
    return el.localName === "textarea" ? el.value !== "" : el.localName === "input" && !NOT_TEXT.has(el.type) && (el.type === "password" || el.value !== "");
  }
  function imageSource(el) {
    const url = el.currentSrc || el.src || "";
    if (url.startsWith("blob:") && el.complete && el.naturalWidth) {
      try {
        const canvas = document.createElement("canvas"); canvas.width = el.naturalWidth; canvas.height = el.naturalHeight;
        canvas.getContext("2d").drawImage(el, 0, 0); return canvas.toDataURL("image/png");
      } catch { return CLEAR; }
    }
    return asset(url);
  }
  function pixels(source, width, height) {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(source, 0, 0, width, height);
    const png = canvas.toDataURL("image/png");
    return png.length > 3 * 1024 * 1024 ? canvas.toDataURL("image/webp", 0.92) : png;
  }

  function text(node, parentTag) {
    const data = node.data;
    if (TABLE.has(parentTag)) return data.trim() ? "" : data;
    if (data.trim()) noteText(data);
    return esc(data);
  }
  function node(child, parentCs, ctx) {
    if (child.nodeType === 3) return text(child, ctx.tag);
    if (child.nodeType !== 1) return "";
    return child.namespaceURI === SVG ? svgElement(child, parentCs, ctx) : element(child, parentCs, ctx);
  }
  function children(el, cs, ctx, tag, scroll) {
    let html = "";
    const inner = { ...ctx, tag, link: ctx.link || tag === "a", button: ctx.button || tag === "button", svgRoot: false, root: null };
    for (const child of childrenOf(el)) {
      if (child.nodeType === 3 && scroll && child.data.trim()) { html += `<span style="position:relative;left:${-scroll.x}px;top:${-scroll.y}px">${text(child, tag)}</span>`; continue; }
      html += node(child, cs, { ...inner, scroll });
      if (html.length > MAX_CHARS) throw new Error("too_large");
    }
    return html;
  }
  function element(el, parentCs, ctx, root = false) {
    const local = el.localName;
    if (DROP.has(local) || (el.namespaceURI === MATH && local === "annotation-xml")) return "";
    const cs = style(el);
    if (cs.display === "none") return "";
    grow();
    if (TABLE.has(ctx.tag) && !TABLE_CHILD.has(local)) return "";
    if (!root && !visibleIn(el, ctx) && !/^(inline|contents)$/u.test(cs.display)) return placeholder(el, cs, parentCs);
    noteFont(cs);
    const extra = (root ? rootReset(el, cs) : "") + translated(cs, ctx.scroll);
    const look = /^(input|button|select|textarea|meter|progress)$/u.test(local) ? nativeLook(el, cs) : null;
    const decl = () => quote((look ? nativeDeclarations(cs, root ? null : parentCs, look) : declarations(cs, root ? null : parentCs)) + extra);
    // A native control keeps the browser's own look: the viewer's reset skips it.
    const mark = look ? " data-native" : "";
    if (ISLAND.has(local) || (local.includes("-") && !el.shadowRoot && !el.childNodes.length && el.getBoundingClientRect().width > 0)) return island(el, cs, parentCs, ctx, extra);
    if ((local === "input" || local === "textarea") && secret(el)) { out.masks.push(rect(shift(box(el.getBoundingClientRect()), ctx.offset))); return masked(cs, parentCs); }
    if (local === "iframe" || local === "frame") return frameBox(el, cs, parentCs, ctx, decl());
    if (local === "canvas") {
      try { return `<img alt="" src="${pixels(el, el.width, el.height)}" style="${decl()}">`; } catch { return island(el, cs, parentCs, ctx, extra); }
    }
    if (local === "video") {
      if (el.readyState >= 2 && el.videoWidth) { try { return `<img alt="" src="${pixels(el, el.videoWidth, el.videoHeight)}" style="${decl()}">`; } catch { /* tainted */ } }
      return el.poster ? `<img alt="" src="${asset(el.poster)}" style="${decl()}">` : island(el, cs, parentCs, ctx, extra);
    }
    if (local === "img") return `<img${attributes(el, "img")} src="${quote(imageSource(el))}" style="${decl()}">`;
    let tag = RENAME[local] ?? (/^h[1-6]$/u.test(local) ? "div" : /^[a-z][a-z0-9-]*$/u.test(local) ? local : "div");
    if ((tag === "a" && ctx.link) || (tag === "button" && ctx.button)) tag = "span";
    if (el.namespaceURI === MATH) tag = local;
    const pseudo = pseudoRules(el, cs, local);
    if (local === "input") {
      const type = /^[a-z-]+$/u.test(el.type) ? el.type : "text";
      let attrs = ` type="${type}"${el.disabled ? " disabled" : ""}${el.checked ? " checked" : ""}`;
      if (NOT_TEXT.has(type) && type !== "file" && el.value) attrs += ` value="${quote(el.value)}"`;
      if (el.placeholder) attrs += ` placeholder="${quote(el.placeholder)}"`;
      if (type === "image") attrs += ` src="${quote(asset(el.src))}" alt="${quote(el.alt)}"`;
      if (NOT_TEXT.has(type) && el.value) noteText(el.value);
      return `<input${attrs}${pseudo}${mark} tabindex="-1" style="${decl()}">`;
    }
    if (local === "textarea") return `<textarea${el.placeholder ? ` placeholder="${quote(el.placeholder)}"` : ""}${el.disabled ? " disabled" : ""}${pseudo}${mark} tabindex="-1" style="${decl()}"></textarea>`;
    const scroll = scrolled(el, cs);
    const open = `<${tag}${attributes(el, tag)}${pseudo}${mark} style="${decl()}">`;
    if (VOID.has(tag)) return open;
    return `${open}${children(el, cs, ctx, tag, scroll)}</${tag}>`;
  }
  /** A copy root sits at the copy's origin: no outer margin, offset, float or transform of the page. */
  function rootReset(el, cs) {
    const r = el.getBoundingClientRect();
    const width = cs.transform !== "none" && el.offsetWidth ? el.offsetWidth : r.width, height = cs.transform !== "none" && el.offsetHeight ? el.offsetHeight : r.height;
    return "margin:0;float:none;top:auto;left:auto;right:auto;bottom:auto;transform:none;translate:none;rotate:none;scale:none;inset:auto;" +
      `position:${/^(absolute|fixed|sticky)$/u.test(cs.position) ? "relative" : cs.position};` +
      (cs.display === "inline" ? `display:block;width:${width}px;height:${height}px;box-sizing:border-box;` : "");
  }

  function svgElement(el, parentCs, ctx) {
    const local = el.localName;
    if (local === "script" || local === "style") return "";
    grow();
    const cs = style(el);
    if (local === "svg" && el.ownerSVGElement === null) {
      // An outer <svg>: in HTML it is a replaced box with the HTML reset; content referencing other files is pixels.
      if ([...el.querySelectorAll("use,feImage")].some(use => { const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? ""; return href && !href.startsWith("#"); })) return island(el, cs, parentCs, ctx, rootlessSvg(el, cs, ctx));
      if (ctx.prune && !visibleIn(el, ctx)) return placeholder(el, cs, parentCs);
    }
    noteFont(cs);
    let attrs = "";
    for (const attribute of el.attributes) {
      const name = attribute.name, value = attribute.value;
      if (/^on/iu.test(name) || name === "style" || name === "class" || /^data-/u.test(name)) continue;
      if (name === "href" || name === "xlink:href") {
        if (local === "a") { try { const url = new URL(value, el.baseURI); if (/^(https?|mailto):$/u.test(url.protocol)) attrs += ` href="${quote(url.href)}"`; } catch { /* dropped */ } continue; }
        if (value.startsWith("#")) { out.refs.add(value.slice(1)); attrs += ` ${name}="${quote(value)}"`; continue; }
        if (local === "image" || local === "feImage") { try { attrs += ` href="${quote(asset(new URL(value, el.baseURI).href))}"`; } catch { /* dropped */ } }
        continue;
      }
      if (name === "id") out.ids.add(value);
      for (const match of value.matchAll(/url\(\s*["']?#([^"')\s]+)/gu)) out.refs.add(match[1]);
      attrs += ` ${name}="${quote(value)}"`;
    }
    const extra = el.ownerSVGElement === null ? rootlessSvg(el, cs, ctx) : translated(cs, ctx.scroll);
    const open = `<${local}${attrs} style="${quote(declarations(cs, ctx.svgRoot ? null : parentCs) + extra)}">`;
    let html = "";
    const inner = { ...ctx, tag: local, scroll: null, svgRoot: false };
    for (const child of el.childNodes) {
      if (child.nodeType === 3) { html += esc(child.data); noteText(child.data); }
      else if (child.nodeType === 1 && child.namespaceURI === SVG) html += svgElement(child, cs, inner);
      else if (child.nodeType === 1 && local === "foreignObject") html += element(child, cs, { ...inner, tag: "div" });
    }
    return `${open}${html}</${local}>`;
  }
  function rootlessSvg(el, cs, ctx) { return (ctx.root === el ? rootReset(el, cs) : "") + translated(cs, ctx.scroll); }

  /** An iframe becomes a box of the same look whose viewport holds the frame's document as it is scrolled now. */
  function frameBox(el, cs, parentCs, ctx, decl) {
    const display = /^inline$/u.test(cs.display) ? "display:inline-block;" : "";
    const info = frameInfo(el), doc = childDocument(el);
    const clip = meet(shift(info.content, ctx.offset), ctx.clip);
    let inner;
    if (doc) inner = documentView(doc, { ...ctx, offset: { x: ctx.offset.x + info.offset.x, y: ctx.offset.y + info.offset.y }, clip, tag: "div", scroll: null, link: false, button: false });
    else {
      const path = framePath(el.contentWindow);
      if (path) {
        const marker = `<!--butler-frame:${prefix}-${out.frames.length}-->`;
        out.frames.push({ marker, path, offset: { x: ctx.offset.x + info.offset.x, y: ctx.offset.y + info.offset.y }, clip: empty(clip) ? null : clip,
          prune: ctx.prune ? rect(shift(meet(ctx.prune, shift(info.content, ctx.offset)), { x: -(ctx.offset.x + info.offset.x), y: -(ctx.offset.y + info.offset.y) })) : null });
        inner = marker;
      } else inner = `<div style="display:block;width:100%;height:100%;background:${MASK}"></div>`;
    }
    return `<div style="${decl}${display}"><div style="display:block;position:relative;overflow:hidden;contain:strict;width:100%;height:100%">${inner}</div></div>`;
  }
  /** The canvas color behind a document: its root's background, else its body's. */
  function canvasColor(doc) {
    for (const el of [doc.documentElement, doc.body]) { const color = el && style(el).backgroundColor; if (color && !/^(transparent|rgba\(0, 0, 0, 0\))$/u.test(color)) return color; }
    return "transparent";
  }
  function documentView(doc, ctx) {
    const win = doc.defaultView, html = doc.documentElement;
    out.roots.add(doc);
    const height = Math.max(html.scrollHeight, html.clientHeight);
    return `<div style="display:block;position:absolute;left:${-win.scrollX}px;top:${-win.scrollY}px;width:${html.clientWidth}px;height:${height}px;background:${canvasColor(doc)}">` +
      `${element(html, null, { ...ctx, tag: "div" })}</div>`;
  }
  /** What shows behind el in the page: its ancestors' background colors over the canvas, composited. */
  function backdrop(el) {
    const layers = [];
    for (let a = el.assignedSlot ?? el.parentElement ?? el.parentNode?.host; a; a = a.assignedSlot ?? a.parentElement ?? a.parentNode?.host) {
      const m = /rgba?\(([^)]*)\)/u.exec(style(a).backgroundColor), p = m?.[1].split(/[\s,/]+/u).filter(Boolean).map(parseFloat);
      if (!p || (p.length > 3 && p[3] === 0)) continue;
      layers.push([p[0], p[1], p[2], p.length > 3 ? p[3] : 1]);
      if (layers.at(-1)[3] >= 1) break;
    }
    let color = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) color = [r * a + color[0] * (1 - a), g * a + color[1] * (1 - a), b * a + color[2] * (1 - a)];
    return `rgb(${color.map(Math.round).join(", ")})`;
  }
  /** Same-origin owner frames between el's document and this world's document. */
  function offsetOf(doc) {
    let x = 0, y = 0;
    for (; doc !== document; doc = doc.defaultView.frameElement.ownerDocument) { const info = frameInfo(doc.defaultView.frameElement); x += info.offset.x; y += info.offset.y; }
    return { x, y };
  }

  /** SVG ids referenced from inside the copy but defined outside it (shared gradients, symbols, clip paths). */
  function definitions() {
    let html = "";
    const done = new Set(out.ids);
    for (let round = 0; round < 8; round++) {
      const missing = [...out.refs].filter(id => !done.has(id));
      if (!missing.length) break;
      for (const id of missing) {
        done.add(id);
        const found = [...out.roots].map(root => root.getElementById?.(id)).find(el => el?.namespaceURI === SVG);
        if (found) html += svgElement(found, null, { offset: { x: 0, y: 0 }, clip: null, prune: null, tag: "defs", svgRoot: true });
      }
    }
    return html ? `<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>${html}</defs></svg>` : "";
  }

  async function finish(html, extra) {
    const parts = { html: html + definitions(), css: out.rules.join("") };
    await inlineBlobs(out.assets, parts, CLEAR);
    return { ...extra, html: parts.html, css: parts.css, assets: [...out.assets], islands: out.islands, frames: out.frames, masks: out.masks,
      fonts: fontFaces(), families: [...out.families].map(([family, keys]) => [family, [...keys]]), chars: [...out.chars].join(""), base: location.href };
  }
  try {
    const view = { left: 0, top: 0, right: document.documentElement.clientWidth || innerWidth, bottom: document.documentElement.clientHeight || innerHeight };
    if (args.op === "element") {
      // The App's own UI names its part by a transient marker instead of a pick identity.
      const el = args.selector ? document.querySelector(args.selector) : elementOf(args.identity);
      if (!el?.isConnected) return null;
      const offset = offsetOf(el.ownerDocument), r = el.getBoundingClientRect(), cs = style(el);
      const transformed = cs.transform !== "none" && el.offsetWidth !== undefined;
      const width = transformed ? el.offsetWidth : r.width, height = transformed ? el.offsetHeight : r.height;
      if (width < 1 || height < 1) return null;
      const ctx = { offset, clip: view, prune: null, tag: "div", root: el, svgRoot: true };
      const parent = el.assignedSlot ?? el.parentElement ?? el.parentNode?.host;
      let html = el.namespaceURI === SVG ? svgElement(el, null, ctx) : element(el, null, ctx, true);
      if (el.namespaceURI === SVG && el.ownerSVGElement) {
        // A part of a drawing: its parent's user space placed at the copy's origin.
        const m = el.parentNode.getScreenCTM?.() ?? new DOMMatrix();
        html = `<svg width="${width}" height="${height}" style="display:block;overflow:hidden"><g transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e - r.left} ${m.f - r.top})">${html}</g></svg>`;
      }
      // Table parts parse only inside a table: wrap them in one with the page table's border model.
      const table = el.closest?.("table"), model = table ? style(table) : null;
      // The part's box starts where its table drew it: half a collapsed border, or past the border spacing.
      const cells = el.localName === "tr" ? [...el.cells] : /^(td|th)$/u.test(el.localName) ? [el] : [...el.rows?.[0]?.cells ?? []];
      const [h = 0, v = h] = model?.borderSpacing.split(" ").map(px) ?? [];
      const edge = model?.borderCollapse === "collapse" && cells.length
        ? `margin:${-Math.max(...cells.map(cell => px(style(cell).borderTopWidth))) / 2}px 0 0 ${-px(style(cells[0]).borderLeftWidth) / 2}px;` : `margin:${-v}px 0 0 ${-h}px;`;
      const wrap = model && `display:table;border-collapse:${model.borderCollapse};border-spacing:${model.borderSpacing};width:${width}px;${edge}`;
      if (/^(tr)$/u.test(el.localName) && wrap) html = `<table style="${wrap}"><tbody style="display:table-row-group">${html}</tbody></table>`;
      else if (/^(td|th)$/u.test(el.localName) && wrap) html = `<table style="${wrap}"><tbody style="display:table-row-group"><tr style="display:table-row">${html}</tr></tbody></table>`;
      else if (/^(thead|tbody|tfoot|caption|colgroup)$/u.test(el.localName) && wrap) html = `<table style="${wrap}">${html}</table>`;
      return await finish(html, { width, height, backdrop: parent ? backdrop(el) : canvasColor(el.ownerDocument), x: r.left + offset.x, y: r.top + offset.y });
    }
    if (args.op === "area") {
      const a = { left: args.rect.x, top: args.rect.y, right: args.rect.x + args.rect.width, bottom: args.rect.y + args.rect.height };
      const ctx = { offset: { x: 0, y: 0 }, clip: view, prune: a, tag: "div", root: null, svgRoot: true };
      const page = documentView(document, ctx);
      const html = `<div style="display:block;position:relative;width:${args.rect.width}px;height:${args.rect.height}px;overflow:hidden;contain:strict">` +
        `<div style="display:block;position:absolute;left:${-a.left}px;top:${-a.top}px;width:${view.right}px;height:${view.bottom}px;overflow:hidden;contain:strict">${page}</div></div>`;
      return await finish(html, { width: args.rect.width, height: args.rect.height, backdrop: canvasColor(document) === "transparent" ? "rgb(255, 255, 255)" : canvasColor(document), x: a.left, y: a.top });
    }
    if (args.op === "frame") {
      const prune = args.prune ? { left: args.prune.x, top: args.prune.y, right: args.prune.x + args.prune.width, bottom: args.prune.y + args.prune.height } : null;
      const ctx = { offset: { x: 0, y: 0 }, clip: view, prune, tag: "div", root: null, svgRoot: true };
      return await finish(documentView(document, ctx), { width: view.right, height: view.bottom });
    }
  } catch (error) {
    if (String(error?.message) === "too_large") return { tooLarge: true };
    throw error;
  }
  return null;
}
