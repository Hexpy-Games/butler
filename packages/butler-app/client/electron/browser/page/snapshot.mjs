import * as helpers from "./perception.mjs";
import { readingText } from "./text.mjs";
import { resolveRef, selectValue } from "./refs.mjs";

function collect(root, elements, candidates) {
  for (const label of root.querySelectorAll("label")) {
    const control=label.control, labels=globalThis.__butlerPerceptionCache.labels;
    if(control && !labels.has(control)) labels.set(control,label.textContent);
  }
  for (const element of root.querySelectorAll('button,a,select,textarea,canvas,summary,input,[role],[onclick],h1,h2,h3,h4,h5,h6,[contenteditable],[contenteditable] *')) candidates.add(element);
  for (const element of root.querySelectorAll("*")) {
    elements.push(element);
    if (element.shadowRoot) collect(element.shadowRoot, elements, candidates);
  }
}
function snapshot(options) {
  globalThis.__butlerPerceptionCache={styles:new WeakMap(),paint:new WeakMap(),boxes:new WeakMap(),rectangles:new WeakMap(),luminances:new Map(),labels:new WeakMap()};
  const start = performance.now(), elements = [], nodes = [], hidden = { invisible: 0, low_contrast: 0, tiny: 0 };
  const candidates = new WeakSet();
  collect(document, elements, candidates);
  for (const root of globalThis.__butlerClosedRoots ?? []) collect(root, elements, candidates);
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
    const meaning = semantic(element, fromGrid);
    if (!meaning.clickable && !/^h[1-6]$/u.test(element.localName)) return;
    seen.add(element);
    const raw = boxOf(element);
    if (raw.top >= innerHeight) { below++; return; }
    const excluded = rendering(element);
    if (excluded) { hidden[excluded]++; return; }
    const point = visiblePoint(element), ref = reference(element);
    const coveredBy = point.blocker ? reference(point.blocker) : undefined;
    nodes.push({ ref, targetId: element.id || undefined, frameOrigin: location.origin, role: meaning.role,
      name: meaning.name, interactive: meaning.clickable, secure: meaning.secure, ad: meaning.ad, checked: meaning.checked, preselected: meaning.preselected,
      actionable: meaning.clickable && !coveredBy && !element.disabled && !meaning.secure,
      coveredBy, coveredTargetId: point.blocker?.id || undefined });
  };
  const gridCandidates=[];
  const emitStart = performance.now();
  for (const element of elements) if (options.full_grid || candidates.has(element)) emit(element);
  const emitMs = performance.now() - emitStart;
  for (const element of elements) {
    if (seen.has(element)) continue;
    const box=boxOf(element);
    if (box.width>=4 && box.height>=4 && box.bottom>0 && box.right>0 && box.top<innerHeight && box.left<innerWidth && styleValue(element,"cursor")==="pointer") gridCandidates.push(box);
  }
  const gridStart = performance.now();
  for (let y = 12; y < innerHeight; y += 24) for (let x = 12; x < innerWidth; x += 24) {
    // A non-pointer, non-semantic hit cannot add an interactive node. Keep the
    // 24px sample positions; avoid native hit tests only in such empty cells.
    if (!options.full_grid && !gridCandidates.some(b=>x>=b.left && x<b.right && y>=b.top && y<b.bottom)) continue;
    const hit = hitAt(document, x, y); if (hit && !seen.has(hit)) emit(hit, true);
  }
  const gridSampleMs = performance.now() - gridStart;
  const text = nodes.map(node => `${node.role} ${JSON.stringify(node.name)} [${node.ref}]${node.coveredBy ? ` covered_by ${node.coveredBy}` : ""}${node.secure ? " secure (takeover only)" : ""}${node.ad ? " ad?" : ""}${node.checked ? " checked" : ""}${node.preselected ? " preselected" : ""} frame=${location.hostname}`).join("\n");
  const proseStart=performance.now();
  const prose = readingText(options.scope,elements);
  return { nodes, text: [text, prose].filter(Boolean).join("\n"), hidden, totals: { interactive: nodes.filter(node=>node.interactive).length, below_fold: below }, scriptMs: performance.now() - start, gridSampleMs, walkerMs:gridStart-start, proseMs:performance.now()-proseStart,
    collectMs, emitMs, payment: elements.some(e => /cc-number|cc-csc/u.test(e.autocomplete ?? "")),
    addons: nodes.filter(n => n.checked || n.preselected).map(n => n.name) };
}

// Each call uses a distinct observation namespace; no page-global ref or eval API is exposed to models.
export function perceptionSource(options) {
  return `(() => {${Object.values(helpers).map(fn => fn.toString()).join("\n")}\n${collect.toString()}\n${readingText.toString()}\n${resolveRef.toString()}\n${selectValue.toString()}\nObject.assign(globalThis, { ${Object.keys(helpers).join(", ")} });\nreturn (${snapshot.toString()})(${JSON.stringify(options)}); })()`;
}
export const resolveSource = input => `(${resolveRef.toString()})(${JSON.stringify(input)})`;
export const selectSource = input => `(${selectValue.toString()})(${JSON.stringify(input)})`;
