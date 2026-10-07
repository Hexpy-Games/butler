export function styleValue(element, property) {
  const cache = globalThis.__butlerPerceptionCache;
  if (!cache) return getComputedStyle(element)[property];
  let entry = cache.styles.get(element);
  if (!entry) { entry = { style: getComputedStyle(element), values: {} }; cache.styles.set(element, entry); }
  // Read only the properties needed by this element; getters cross into Blink.
  if (!(property in entry.values)) entry.values[property] = entry.style[property];
  return entry.values[property];
}
export function boxOf(element) {
  const cache = globalThis.__butlerPerceptionCache;
  if (!cache) return element.getBoundingClientRect();
  if (!cache.boxes.has(element)) cache.boxes.set(element,element.getBoundingClientRect());
  return cache.boxes.get(element);
}
// Functions are serialized into a Butler-owned isolated world, shared by the L1 provider.
export function parentElementOf(element) {
  return element.parentElement ?? element.getRootNode()?.host ?? null;
}
export function rectangle(element) {
  const cache=globalThis.__butlerPerceptionCache?.rectangles;
  if (cache?.has(element)) return cache.get(element);
  const box = boxOf(element);
  let left = Math.max(0, box.left), top = Math.max(0, box.top);
  let right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
  for (let parent = parentElementOf(element); parent; parent = parentElementOf(parent)) {
    const clipsX = /(hidden|clip|scroll|auto)/u.test(styleValue(parent, "overflowX"));
    const clipsY = /(hidden|clip|scroll|auto)/u.test(styleValue(parent, "overflowY"));
    if (!clipsX && !clipsY) continue;
    const bounds = boxOf(parent);
    if (clipsX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (clipsY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  const rect={ x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  cache?.set(element,rect);
  return rect;
}
export function paintState(element) {
  const cache=globalThis.__butlerPerceptionCache?.paint;
  if(cache?.has(element)) return cache.get(element);
  const parent=parentElementOf(element), inherited=parent?paintState(parent):{opacity:1,invisible:false};
  const opacity=inherited.opacity*Number(styleValue(element,"opacity"));
  const clip=styleValue(element,"clip"), clipPath=styleValue(element,"clipPath");
  const invisible=inherited.invisible || styleValue(element,"display")==="none" || styleValue(element,"visibility")!=="visible"
    || element.hasAttribute("inert") || element.getAttribute("aria-hidden")==="true"
    || clip!=="auto" && /rect\(0px, 0px, 0px, 0px\)/u.test(clip)
    || clipPath==="inset(100%)" || clipPath==="circle(0px)";
  const result={opacity,invisible};cache?.set(element,result);return result;
}
export function rendering(element) {
  const cache=globalThis.__butlerPerceptionCache?.renderings;
  if(cache?.has(element)) return cache.get(element);
  const result=renderingState(element);
  cache?.set(element,result);
  return result;
}
export function renderingState(element) {
  const paint=paintState(element);
  if(paint.invisible || paint.opacity<.1) return "invisible";
  if (fullyClipped(element)) return "invisible";
  const box = rectangle(element);
  if (box.width < 4 || box.height < 4) return "tiny";
  if (parseFloat(styleValue(element,"fontSize")) < 6 && element.textContent?.trim()) return "tiny";
  if (contrast(element) < 1.5 && element.textContent?.trim()) return "low_contrast";
  return null;
}
export function contrast(element) {
  const rgb = value => value.match(/[\d.]+/gu)?.map(Number) ?? [];
  const fg = rgb(styleValue(element, "color"));
  let bg = [];
  for (let parent = element; parent; parent = parentElementOf(parent)) {
    bg = rgb(styleValue(parent, "backgroundColor"));
    if (bg.length >= 3 && (bg[3] ?? 1) > 0.9) break;
  }
  if (bg.length < 3 || (bg[3] ?? 1) < 0.9) bg = [255, 255, 255];
  const luminance = values => {
    const key=values.slice(0,3).join(","), cache=globalThis.__butlerPerceptionCache?.luminances;
    if(cache?.has(key)) return cache.get(key);
    const value=values.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
      .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    cache?.set(key,value);return value;
  };
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function semantic(element, discoverPointer = true) {
  const tag = element.localName, type = element.getAttribute("type");
  const role = element.getAttribute("role") ?? ({ button: "button", a: "link", select: "combobox", textarea: "textbox", canvas: "canvas", summary: "button" }[tag])
    ?? (tag === "input" ? ({ checkbox: "checkbox", radio: "radio", range: "slider", submit: "button", button: "button" }[type] ?? "textbox") : scrollRegion(element) ? "scroll_region" : "");
  const clickable = Boolean(role || element.hasAttribute("onclick") || discoverPointer && styleValue(element, "cursor") === "pointer" || element.isContentEditable);
  if (!clickable && !/^h[1-6]$/u.test(tag)) return { clickable: false };
  const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u).map(id => element.getRootNode().getElementById?.(id) ? visibleLabel(element.getRootNode().getElementById(id)) : "").join(" ");
  const secure = secureKeypad(element) || /recaptcha|hcaptcha|captcha|transkey|nxkey|nprotect|anysign|wizvera/iu.test(location.href) || /one-time-code/u.test(element.autocomplete ?? "") || type === "password" || /cc-number|cc-csc|cc-exp/u.test(element.autocomplete ?? "") || /card.?number|cvc|cvv|transkey|nxkey|nprotect|anysign|wizvera|(?:^|[ _-])(?:otp|mfa|2fa|verification.?code|auth.?code)(?:$|[ _-])/iu.test(`${element.id} ${element.className} ${element.getAttribute("name") ?? ""}`);
  let name = element.getAttribute("aria-label") || labelled.trim() || (globalThis.__butlerPerceptionCache?.labels ? globalThis.__butlerPerceptionCache.labels.get(element) : element.labels?.[0]?.textContent) || element.getAttribute("alt") || element.getAttribute("title") || visibleLabel(element) || element.getAttribute("placeholder") || "";
  if (!name) { const b = rectangle(element); name = `icon ${Math.round(b.width)}×${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)}`; }
  const parent = parentElementOf(element);
  const ad = /^(ads?[.-]|.*\.doubleclick\.)/iu.test(location.hostname) || /^(광고|AD|Sponsored|스폰서)(?:\s|$)/iu.test(parent?.getAttribute("aria-label") ?? "") || /^(AD|광고)\b/u.test(parent?.childNodes?.[0]?.textContent?.trim() ?? "") || element.rel?.split(" ").includes("sponsored");
  return { role: role || "button", name: name.replace(/\s+/gu, " "), secure, ad: Boolean(ad), clickable, checked: Boolean(element.checked), preselected: Boolean(element.defaultChecked) };
}
export function hitAt(root, x, y) {
  let hit = root.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const deeper = hit.shadowRoot.elementFromPoint(x, y); if (!deeper || deeper === hit) break; hit = deeper; }
  return hit;
}
export function visiblePoint(element) {
  const modal = modalLayer();
  if (modal && modal !== element && !modal.contains(element)) return { blocker: modal };
  const b = rectangle(element), root = element.getRootNode();
  const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
  let blocker = null;
  for (const [dx, dy] of points) {
    const x = b.x + b.width * dx, y = b.y + b.height * dy;
    const hit = hitAt(root.elementFromPoint ? root : document, x, y);
    if (hit === element || element.contains(hit)) return { x, y, blocker: null };
    if (hit) {
      let coverer = hit;
      for (let parent = hit; parent; parent = parentElementOf(parent)) {

        if (styleValue(parent, "position") === "fixed" && Number(styleValue(parent, "zIndex")) > 0) coverer = parent;
      }
      blocker ??= coverer;
    }
  }
  return { blocker };
}

/** Policy markers come from Rust, and cover every descendant of a keypad. */
export function secureKeypad(element) {
  const markers=globalThis.__butlerObservation?.secureKeypads ?? [];
  if(!markers.length) return false;
  for(let node=element;node;node=parentElementOf(node)) {
    const label=`${node.id} ${node.getAttribute("class") ?? ""} ${node.getAttribute("name") ?? ""}`.toLowerCase();
    if(markers.some(marker=>label.includes(marker))) return true;
  }
  return false;
}

/** Exact approval metadata is reread immediately before every dispatch. */
export function currentAddons() {
  return [...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')]
    .filter(element=>(element.checked || element.defaultChecked) && !paintState(element).invisible && paintState(element).opacity>=.1)
    .map(element=>semantic(element)).filter(meaning=>!meaning.secure).map(meaning=>meaning.name);
}

/** CSS clip is independent of layout dimensions and inherited through containers. */
export function fullyClipped(element) {
  const cache = globalThis.__butlerPerceptionCache?.clips;
  if (cache?.has(element)) return cache.get(element);
  const parent = parentElementOf(element), box = boxOf(element);
  const clip = styleValue(element, "clip").match(/^rect\((.*)\)$/u);
  const edges = clip?.[1].split(/[ ,]+/u).map(value => value === "auto" ? null : parseFloat(value));
  const clipped = Boolean(parent && fullyClipped(parent)) || Boolean(edges &&
    ((edges[1] ?? box.width) <= (edges[3] ?? 0) || (edges[2] ?? box.height) <= (edges[0] ?? 0)));
  cache?.set(element, clipped);
  return clipped;
}

/** Accessible names never inherit invisible descendants' page text. */
export function visibleLabel(element) {
  if (rendering(element)) return "";
  if (!element.children.length) return element.textContent?.trim() ?? "";
  const text = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript") || rendering(parent)) continue;
    text.push(node.textContent);
  }
  return text.join(" ").replace(/\s+/gu, " ").trim();
}

/** Respect native/ARIA modality and large fixed dialog surfaces used by older sites. */
export function modalLayer() {
  const cache = globalThis.__butlerPerceptionCache;
  if (cache && "modal" in cache) return cache.modal;
  const declared = [...document.querySelectorAll('dialog[open],[aria-modal="true"]')]
    .filter(element => !paintState(element).invisible && paintState(element).opacity >= .1);
  let modal = declared.at(-1) ?? null;
  for (const [x,y] of [[innerWidth/2,innerHeight/2],[innerWidth/4,innerHeight/4],[innerWidth*3/4,innerHeight*3/4]]) {
    for (let hit = hitAt(document,x,y); hit; hit = parentElementOf(hit)) {
      if (styleValue(hit,"position") !== "fixed" || Number(styleValue(hit,"zIndex")) <= 0) continue;
      const box = rectangle(hit);
      if (box.width * box.height < innerWidth * innerHeight / 2 || paintState(hit).opacity < .1) continue;
      if (!modal || Number(styleValue(hit,"zIndex")) > Number(styleValue(modal,"zIndex"))) modal = hit;
    }
  }
  if (cache) cache.modal = modal;
  return modal;
}

/** A virtualized container must have a ref so ordinary scroll/re-observe can reach new rows. */
export function scrollRegion(element) {
  const box = boxOf(element);
  if (box.width < 4 || box.height < 4 || box.top >= innerHeight || box.bottom <= 0) return false;
  const vertical = /^(auto|scroll)$/u.test(styleValue(element,"overflowY"));
  const horizontal = /^(auto|scroll)$/u.test(styleValue(element,"overflowX"));
  return vertical && element.scrollHeight > element.clientHeight
    || horizontal && element.scrollWidth > element.clientWidth;
}
