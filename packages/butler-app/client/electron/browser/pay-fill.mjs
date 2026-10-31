import { frameWorlds, evaluateWorld, framePoint } from "./frame-worlds.mjs";
import { mouseSender, routeTarget } from "./frame-input.mjs";
import { vaultKind } from "./page/perception.mjs";
import { vaultChoose, vaultFocus, vaultMark, vaultScan } from "./page/vault.mjs";
import { fieldOf, plan, texts } from "./pay-values.mjs";

/** Saved card and autofill fills (`pay.inspect`, `pay.fill`, `autofill.fill`).
 * Main checks the top-level origin and every frame origin against the token's
 * binding, pulls the values once with the single-use token, types them with
 * native text input (selects and dates are set in Butler's world), marks the
 * fields filled so observations hide them and screenshots mask them, and
 * drops the values. Results carry field kinds, never a value. */

const source = (fn, input) => `(()=>{${vaultKind.toString()}\nreturn (${fn.toString()})(${JSON.stringify(input)})})()`;
const originOf = raw => { try { return new URL(raw).origin; } catch { return ""; } };

async function scan(tab, args) {
  const frames = [];
  for (const frame of await frameWorlds(tab)) {
    let result;
    try { result = await evaluateWorld(frame, source(vaultScan, { sectionRef: args.section_ref ?? null, markers: tab.policy?.secure_keypads ?? [], targets: args.kind === "profile" ? args.targets : undefined })); }
    catch { continue; }
    if (result?.section === "missing") continue;
    if (result) frames.push({ ...result, world: frame });
  }
  return frames;
}

function incompatibleTargets(frames) {
  const targets = frames.flatMap(frame => frame.incompatible ?? []);
  return targets.length ? { status: "not_dispatched", reason: "incompatible_target", targets,
    recovery: "Observe and choose targets whose accessible label, autocomplete, name, input type and inputmode match each sensitive field kind." } : null;
}

function merchantOrigin(browser, tab, top) {
  const opener = tab.opener ? browser.tabs.get(tab.opener) : null;
  return opener?.url ? originOf(opener.url) || top : top;
}

function humanStep(frames) {
  for (const frame of frames) if (frame.human) return frame.human;
  return null;
}

function handOver(browser, tab, controlTab, reason, extra = {}) {
  tab.payStep = reason;
  controlTab(browser, tab, "user", true);
  return { status: "user_required", reason, tab: tab.id, url: tab.url, ...extra };
}

/** `pay.inspect`: origins, field kinds, the amount shown and any step only the user can do. */
export async function inspectPay(browser, tab, args, controlTab) {
  const kind = args.kind === "profile" ? "profile" : "card";
  const top = originOf(tab.view.webContents.getURL());
  const frames = await scan(tab, args);
  const refusal = incompatibleTargets(frames);
  if (refusal) return refusal;
  if (args.section_ref && !frames.length) return { status: "not_dispatched", reason: "section_missing", tab: tab.id,
    recovery: "section_ref is not in the latest observation. Observe and pass current form field refs." };
  if (kind === "profile" && (!Array.isArray(args.targets) || !args.targets.length
    || frames.reduce((n, frame) => n + frame.targets.length, 0) !== args.targets.length))
    return { status: "not_dispatched", reason: "target_missing", recovery: "Observe and pass current form field refs." };
  const relevant = frames.filter(frame => frame.targets.some(target => fieldOf(kind, target)));
  const human = humanStep(frames);
  const amount = frames[0]?.amount ?? frames.find(frame => frame.amount)?.amount ?? null;
  const fields = [...new Set(relevant.flatMap(frame => frame.targets.map(target => fieldOf(kind, target)).filter(Boolean)))];
  if (!relevant.length) {
    if (human) return handOver(browser, tab, controlTab, human, { merchant_origin: merchantOrigin(browser, tab, top), filled: [] });
    return { status: "no_fields", tab: tab.id, url: tab.url,
      recovery: kind === "card" ? "No card fields are visible. Observe and reach the step where the page asks for the card (choose card payment or the card company), then call again."
        : "No profile targets are visible. Observe and pass current form field refs." };
  }
  return { status: "ok", tab: tab.id, url: tab.url, top_origin: top, merchant_origin: merchantOrigin(browser, tab, top),
    frame_origins: [...new Set(relevant.map(frame => frame.origin))], fields, amount, human_step: human };
}

/** Types one text into a focused target: native text input in its own renderer. */
async function typeInto(tab, frame, id, text) {
  const focused = await evaluateWorld(frame, source(vaultFocus, { id }));
  if (!focused?.ok) return false;
  if (!focused.focused) {
    // Focus inside another renderer may need a real click on the field.
    const center = await framePoint(frame, { x: focused.rect.x + focused.rect.width / 2, y: focused.rect.y + focused.rect.height / 2 });
    const scale = tab.bounds?.scale ?? 1, point = { x: Math.round(center.x * scale), y: Math.round(center.y * scale) };
    const send = mouseSender(tab, routeTarget({}, frame));
    tab.expectedInputs = ["mouseDown", "mouseUp"].map(type => ({ type, ...point }));
    for (const type of ["mouseDown", "mouseUp"]) await send({ type, ...point, button: "left", clickCount: 1 });
    await evaluateWorld(frame, source(vaultFocus, { id }));
  }
  tab.expectedInputs = [];
  if (frame.sessionId) await frame.api.sendCommand("Input.insertText", { text });
  else await tab.view.webContents.insertText(text);
  return true;
}

/** Fills one step's parts; false when the page refused a value. */
async function put(tab, step, list) {
  const frame = step.frame.world;
  if (step.radios) return Boolean(list[0]) && (await evaluateWorld(frame, source(vaultChoose, { id: list[0].id, value: "" })))?.ok === true;
  for (const [index, part] of step.parts.entries()) {
    const text = list[index];
    if (typeof text !== "string" || !text) return false;
    if (part.tag === "select" || ["date", "month"].includes(part.type)) {
      if ((await evaluateWorld(frame, source(vaultChoose, { id: part.id, value: text })))?.ok !== true) return false;
    } else if (!await typeInto(tab, frame, part.id, text)) return false;
  }
  return true;
}

/** `pay.fill` / `autofill.fill`: one fill under the token's exact origins. */
export async function fillPay(browser, tab, args, controlTab) {
  const kind = args.kind === "profile" ? "profile" : "card";
  const contents = tab.view.webContents;
  if (tab.holder !== "agent") return { status: "not_dispatched", reason: "user_control", tab: tab.id };
  const top = originOf(contents.getURL());
  if (top !== args.top_origin) return { status: "origin_mismatch", tab: tab.id, url: contents.getURL() };
  const bound = new Set([top, ...(Array.isArray(args.frame_origins) ? args.frame_origins : [])]);
  const frames = (await scan(tab, args)).filter(frame => bound.has(frame.origin));
  const refusal = incompatibleTargets(frames);
  if (refusal) return refusal;
  const steps = plan(kind, frames);
  if (kind === "profile" && steps.length !== args.targets?.length) return { status: "not_dispatched", reason: "target_missing", tab: tab.id };
  const human = humanStep(frames);
  if (!steps.length) return human ? handOver(browser, tab, controlTab, human, { filled: [] }) : { status: "no_fields", tab: tab.id, url: contents.getURL() };
  const used = [...new Set(steps.map(step => step.frame.origin))];
  const pulled = await browser.pullVault?.(String(args.fill_token ?? ""), top, used);
  if (pulled?.error === "origin_mismatch") return { status: "origin_mismatch", tab: tab.id, url: contents.getURL() };
  if (!pulled?.values) return { status: "not_dispatched", reason: "vault_unavailable", tab: tab.id };
  const filled = [], missing = [], keypads = [];
  try {
    if (originOf(contents.getURL()) !== top) return { status: "origin_mismatch", tab: tab.id, url: contents.getURL() };
    for (const step of steps) {
      if (step.parts?.some(part => part.keypad || part.readOnly)) { keypads.push(step.field); continue; }
      const list = texts(step, pulled.values, args.meta ?? {});
      if (!list || list.some(item => item === null || item === undefined)) { missing.push(step.field); continue; }
      // Closed before the first keystroke, and stays closed however this ends.
      tab.readsClosed = { inPage: null };
      if (await put(tab, step, list)) filled.push(step); else missing.push(step.field);
    }
  } finally {
    for (const key of Object.keys(pulled.values)) pulled.values[key] = null;
  }
  for (const frame of new Set(filled.map(step => step.frame))) {
    const ids = filled.filter(step => step.frame === frame).flatMap(step => (step.radios ?? step.parts).map(part => part.id));
    await evaluateWorld(frame.world, source(vaultMark, { ids })).catch(() => []);
  }
  if (filled.length) tab.vaultFilled = true;
  const result = { tab: tab.id, url: contents.getURL(), filled: filled.map(step => step.field), missing, frame_origin: filled[0]?.frame.origin ?? top };
  const step = keypads.length ? "secure_keypad" : human;
  if (step) return handOver(browser, tab, controlTab, step, { ...result, missing: [...missing, ...keypads] });
  return { status: "filled", ...result };
}
