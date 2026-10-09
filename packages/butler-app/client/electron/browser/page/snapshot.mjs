import * as helpers from "./perception.mjs";
import { readingText } from "./text.mjs";
import { resolveRef, selectValue } from "./refs.mjs";

function elementChanges(records) {
  return records.some(record => record.type === "attributes" ||
    [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE));
}
function rootIndex(root) {
  const indexes = globalThis.__butlerPerceptionImplementation.indexes;
  let index = indexes.get(root);
  if (!index) {
    index = { dirty: true };
    index.observer = new MutationObserver(records => { index.dirty ||= elementChanges(records); });
    index.observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["role", "onclick", "contenteditable"] });
    indexes.set(root, index);
  }
  const changes = index.observer.takeRecords();
  index.dirty ||= elementChanges(changes);
  if (index.dirty) {
    index.elements = [...root.querySelectorAll("*")];
    index.labels = [...root.querySelectorAll("label")];
    index.candidates = [...root.querySelectorAll('button,a,select,textarea,canvas,img,summary,input,[role],[onclick],[draggable],h1,h2,h3,h4,h5,h6,[contenteditable]')];
    for (const element of [...index.candidates]) if (element.hasAttribute("contenteditable")) for (const child of element.querySelectorAll("*")) index.candidates.push(child);
    index.dirty = false;
  }
  globalThis.__butlerPerceptionCache.roots.add(root);
  return index;
}
function collect(root, elements, candidates) {
  const index = rootIndex(root);
  for (const label of index.labels) {
    const control=label.control, labels=globalThis.__butlerPerceptionCache.labels;
    if(control && !labels.has(control)) labels.set(control,visibleLabel(label));
  }
  for (const element of index.candidates) candidates.add(element);
  for (const element of index.elements) {
    elements.push(element);
    // attachShadow does not emit childList records on the host. Discover roots
    // on every walk, including roots attached to an existing element later.
    if (element.shadowRoot) collect(element.shadowRoot, elements, candidates);
  }
}
function snapshot(options) {
  globalThis.__butlerPerceptionCache={styles:new WeakMap(),paint:new WeakMap(),clips:new WeakMap(),boxes:new WeakMap(),rectangles:new WeakMap(),clipping:new WeakMap(),renderings:new WeakMap(),luminances:new Map(),colors:new Map(),labels:new WeakMap(),viewport:{width:innerWidth,height:innerHeight},page:{origin:location.origin,hostname:location.hostname,url:location.href},roots:new Set()};
  const start = performance.now(), elements = [], nodes = [], hidden = { invisible: 0, low_contrast: 0, tiny: 0 };
  const {width:viewportWidth,height:viewportHeight} = globalThis.__butlerPerceptionCache.viewport;
  const {origin,hostname} = globalThis.__butlerPerceptionCache.page;
  const candidates = new WeakSet();
  collect(document, elements, candidates);
  for (const root of globalThis.__butlerClosedRoots ?? []) collect(root, elements, candidates);
  for (const [root,index] of globalThis.__butlerPerceptionImplementation.indexes) if (!globalThis.__butlerPerceptionCache.roots.has(root)) {
    index.observer.disconnect(); globalThis.__butlerPerceptionImplementation.indexes.delete(root);
  }
  const collectMs = performance.now() - start;
  const refs = new Map(), keys = new WeakMap();
  globalThis.__butlerObservation = { ...options, refs };
  const reference = element => {
    if (!keys.has(element)) { const ref = `${options.prefix}e${keys.size ?? refs.size}`; keys.set(element, ref); refs.set(ref, new WeakRef(element)); }
    return keys.get(element);
  };
  let below = 0;
  const seen = new Set();
  const emit = (element, fromGrid = false) => {
    if (seen.has(element)) return;
    const modal = modalLayer();
    if (element.closest("[inert]") && modal && !modal.contains(element)) {
      if (!candidates.has(element)) return;
      seen.add(element); hidden.invisible++;
      nodes.push({ ref: reference(element), targetId: element.id || undefined, frameOrigin: origin, role: "unavailable", name: "", interactive: false, actionable: false, coveredBy: reference(modal), coveredTargetId: modal.id || undefined });
      return;
    }
    const meaning = semantic(element, fromGrid);
    if (!meaning.clickable && !element.draggable && !/^(img|h[1-6])$/u.test(element.localName)) return;
    seen.add(element);
    const raw = boxOf(element);
    if (raw.top >= viewportHeight) { below++; return; }
    const excluded = rendering(element);
    if (excluded) { hidden[excluded]++; return; }
    const point = visiblePoint(element), ref = reference(element);
    const coveredBy = point.blocker ? reference(point.blocker) : undefined;
    const rect = rectangle(element);
    nodes.push({ ref, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, targetId: element.id || undefined, frameOrigin: origin, role: meaning.role,
      name: meaning.name, value: !meaning.secure && /^(textbox|combobox)$/u.test(meaning.role) && typeof element.value === "string" ? element.value : undefined,
      autocomplete: element.getAttribute("aria-autocomplete") || undefined,
      interactive: meaning.clickable, secure: meaning.secure, ad: meaning.ad, checked: meaning.checked, preselected: meaning.preselected,
      actionable: (meaning.clickable || element.draggable) && !coveredBy && !element.disabled && element.getAttribute("aria-disabled") !== "true" && !meaning.secure,
      coveredBy, coveredTargetId: point.blocker?.id || undefined });
  };
  const gridCandidates=[];
  const emitStart = performance.now();
  for (const element of elements) {
    const box=element.getBoundingClientRect();
    const scrollVisible=box.width>=4 && box.height>=4 && box.bottom>0 && box.top<viewportHeight;
    const inViewport=scrollVisible && box.right>0 && box.left<viewportWidth;
    if (scrollVisible || candidates.has(element)) globalThis.__butlerPerceptionCache.boxes.set(element,box);
    // Semantic targets still visit emit offscreen to retain below-fold totals.
    // Share the walk/grid visibility read; offscreen non-targets cannot scroll
    // or contribute a sampled point and need no native style/property getters.
    if (options.full_grid || candidates.has(element) || scrollVisible && scrollRegion(element)) emit(element);
    if (inViewport && !seen.has(element) && styleValue(element,"cursor")==="pointer") gridCandidates.push(box);
  }
  const emitMs = performance.now() - emitStart;
  const gridStart = performance.now();
  for (let y = 12; y < viewportHeight; y += 24) for (let x = 12; x < viewportWidth; x += 24) {
    // A non-pointer, non-semantic hit cannot add an interactive node. Keep the
    // 24px sample positions; avoid native hit tests only in such empty cells.
    if (!options.full_grid && !gridCandidates.some(b=>x>=b.left && x<b.right && y>=b.top && y<b.bottom)) continue;
    const hit = hitAt(document, x, y); if (hit && !seen.has(hit)) emit(hit, true);
  }
  const gridSampleMs = performance.now() - gridStart;
  const text = nodes.map(node => `${node.role} ${JSON.stringify(node.name)} [${node.ref}]${node.value === undefined ? "" : ` value=${JSON.stringify(node.value)}`}${node.coveredBy ? ` covered_by ${node.coveredBy}` : ""}${node.secure ? " secure (takeover only)" : ""}${node.ad ? " ad?" : ""}${node.checked ? " checked" : ""}${node.preselected ? " preselected" : ""} frame=${hostname}`).join("\n");
  const proseStart=performance.now();
  const prose = readingText(options.scope,elements);
  return { nodes, layout_regions: layoutRegions(elements), text: [text, prose].filter(Boolean).join("\n"), hidden, totals: { interactive: nodes.filter(node=>node.interactive).length, below_fold: below }, scriptMs: performance.now() - start, gridSampleMs, walkerMs:gridStart-start, proseMs:performance.now()-proseStart,
    collectMs, emitMs, payment: elements.some(e => /cc-number|cc-csc/u.test(e.autocomplete ?? "")),
    addons: nodes.filter(n => n.checked || n.preselected).map(n => n.name) };
}

// Keep executable functions warm in the isolated world; page data and refs are
// rebuilt on every call. A source change replaces the implementation atomically.
const implementation = `${Object.values(helpers).map(fn => fn.toString()).join("\n")}\n${elementChanges.toString()}\n${rootIndex.toString()}\n${collect.toString()}\n${readingText.toString()}\n${snapshot.toString()}\n${resolveRef.toString()}\n${selectValue.toString()}`;
export function perceptionSource(options) {
  return `(() => {
    const source = ${JSON.stringify(implementation)};
    if (globalThis.__butlerPerceptionImplementation?.source !== source) {
      ${implementation}
      Object.assign(globalThis, { ${Object.keys(helpers).join(", ")} });
      for (const index of globalThis.__butlerPerceptionImplementation?.indexes?.values() ?? []) index.observer.disconnect();
      globalThis.__butlerPerceptionImplementation = { source, snapshot, indexes: new Map() };
    }
    return globalThis.__butlerPerceptionImplementation.snapshot(${JSON.stringify(options)});
  })()`;
}
export const resolveSource = input => `(${resolveRef.toString()})(${JSON.stringify(input)})`;
export const selectSource = input => `(${selectValue.toString()})(${JSON.stringify(input)})`;
