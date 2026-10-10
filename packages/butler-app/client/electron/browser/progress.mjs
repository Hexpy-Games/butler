// What the last batch did to the page, stated plainly so the model can change
// approach: fields it cleared (and the earlier state that brought back), a batch
// that repeats an earlier one with the same outcome, no effect at all, or new
// options right after typing. Notes carry refs and ids, never page text.
// A batch whose outcome was no progress is not run again from the same state.
const HISTORY = 12;
const GRID = 8;

const fieldKey = field => `${field.position}:${field.name}`;

function snapshot(current) {
  const actionable = current.nodes.filter(node => node.actionable);
  return {
    obs: current.obs,
    fingerprint: [current.url, ...current.fields.map(field => `${fieldKey(field)}=${field.value}`),
      ...actionable.map(node => `${node.role} ${node.name}`).sort()].join("\n"),
    thumb: current.thumb,
    values: new Map(current.fields.map(field => [fieldKey(field), { ref: field.ref, value: field.value }])),
    refs: new Set(actionable.map(node => node.ref)),
    fieldRefs: new Set(current.fields.map(field => field.ref)),
    targets: new Map(current.nodes.map(node => [node.ref, `${node.role} ${node.name}`])),
  };
}

// The element a step reaches (role and name, whatever ref or point named it),
// its value, and its points on a coarse grid.
function identity(step, hit) {
  const grid = point => Array.isArray(point) ? point.map(value => Math.round(value / GRID)).join(",") : "";
  return [step?.action, `${hit?.role ?? ""} ${hit?.name ?? ""}`, step?.value ?? "", grid(step?.point), grid(step?.target_point),
    (step?.path ?? []).map(grid).join(";")].join("|");
}

/** Records the batch so the next observation can compare against its start. */
export function recordBatch(tab, args, steps) {
  tab.lastBatch = { from: args.observation, steps: (args.steps ?? []).map((step, index) => ({
    action: step?.action, ref: step?.ref, point: Boolean(step?.point), value: step?.value,
    identity: identity(step, steps[index]?.hit), completed: steps[index]?.status === "completed" })) };
}

/** Refuses, before anything is dispatched, a batch that starts with steps that
 * already ran from this same page state and made no progress: repeating or
 * extending them would replay the same outcome first. */
export function repeatRefusal(tab, args, prepared) {
  const state = tab.progressHistory?.at(-1);
  if (!state || state.obs !== args.observation || !tab.noProgress?.size) return null;
  const identities = args.steps.map((step, index) => identity(step, prepared[index]?.hit));
  for (let length = 1; length <= identities.length; length++) {
    const last = tab.noProgress.get([state.fingerprint, ...identities.slice(0, length)].join("\n"));
    if (!last) continue;
    const scope = length === identities.length ? "This same batch" : `The first ${length} step${length === 1 ? "" : "s"} of this batch`;
    return { status: "refused", reason: "repeated_no_progress", previous_result: last.obs, step_index: 0,
      recovery: `${scope} already ran from this same page state and ${last.what} (see ${last.obs}). Nothing was run again. Use a different control or approach; re-observe if the page should have changed. No steps were dispatched.` };
  }
  return null;
}

function cleared(previous, entry, batch) {
  const filled = new Set(batch.steps.filter(step => step.completed && ["fill", "type"].includes(step.action) && step.ref).map(step => step.ref));
  return [...previous.values].filter(([key, before]) => before.value && entry.values.get(key)?.value === "" && !filled.has(before.ref))
    .map(([key, before]) => `${key.split(":")[0]} [${entry.values.get(key).ref ?? before.ref}]`);
}

// Only DOM-visible inputs can be judged by the DOM; pixels on a canvas cannot.
function domOnly(previous, batch) {
  return batch.steps.every(step => step.ref && !step.point && ["click", "fill", "select"].includes(step.action) && !previous.targets.get(step.ref)?.startsWith("canvas "));
}

// Pixels decide when both observations carry a thumbnail: a button that pans
// or zooms a map changes pixels, not the DOM.
function samePixels(before, after) {
  if (!before || !after || before.length !== after.length) return true;
  let changed = 0;
  for (let index = 0; index < before.length; index += 4) {
    const delta = Math.abs(before[index] - after[index]) + Math.abs(before[index + 1] - after[index + 1]) + Math.abs(before[index + 2] - after[index + 2]);
    if (delta > 60 && ++changed >= 3) return false;
  }
  return true;
}

function suggestions(previous, entry, batch) {
  const last = batch.steps.filter(step => step.completed).at(-1);
  if (!last || !["fill", "type"].includes(last.action)) return null;
  const appeared = [...entry.refs].filter(ref => !previous.refs.has(ref) && !entry.fieldRefs.has(ref));
  if (appeared.length < 2) return null;
  const field = last.ref ? ` into [${last.ref}]` : "";
  return `${appeared.length} new clickable options appeared right after typing${field}: ${appeared.slice(0, 12).join(", ")}${appeared.length > 12 ? ", …" : ""}. Typed text alone may not commit a choice; select the option that matches, then check the field.`;
}

function remember(tab, previous, entry, batch, what) {
  if (!batch.steps.every(step => step.completed)) return;
  const key = [previous.fingerprint, ...batch.steps.map(step => step.identity)].join("\n");
  const seen = tab.noProgress ??= new Map();
  seen.set(key, { obs: entry.obs, what });
  if (seen.size > 50) seen.delete(seen.keys().next().value);
}

function outcomes(tab, previous, entry, batch, history) {
  const notes = [];
  const lost = cleared(previous, entry, batch);
  if (lost.length) {
    const earlier = history.slice(0, -2).findLast(old => old.fingerprint === entry.fingerprint);
    notes.push(`The last batch cleared field ${lost.join(", ")}, which had a value before${earlier ? `; the page is back to its state at ${earlier.obs}` : ""}. Unless clearing was intended, this undid progress; use a different control instead.`);
    remember(tab, previous, entry, batch, `cleared field ${lost.join(", ")}`);
  }
  if (entry.fingerprint === previous.fingerprint && samePixels(previous.thumb, entry.thumb) && domOnly(previous, batch)) {
    notes.push("The last batch changed nothing visible: no URL, field, control or pixel changed. Try a different control or approach instead of repeating it.");
    remember(tab, previous, entry, batch, "changed nothing visible");
  }
  const options = suggestions(previous, entry, batch);
  if (options) notes.push(options);
  return notes;
}

/** Compares a fresh observation with the one the last batch started from. */
export function noteProgress(tab, current) {
  const entry = snapshot(current), history = tab.progressHistory ??= [];
  const previous = history.at(-1), batch = tab.lastBatch;
  history.push(entry);
  if (history.length > HISTORY) history.shift();
  tab.lastBatch = undefined;
  if (!previous || !batch || batch.from !== previous.obs || !batch.steps.some(step => step.completed)) return undefined;
  const notes = outcomes(tab, previous, entry, batch, history);
  return notes.length ? { since: previous.obs, notes } : undefined;
}
