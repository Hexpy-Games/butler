// What the last batch did to the page, stated plainly so the model can change
// approach: fields it cleared (and the earlier state that brought back), a batch
// that repeats an earlier one with the same outcome, no effect at all, or new
// options right after typing. Notes carry refs and ids, never page text.
const HISTORY = 12;

const fieldKey = field => `${field.position}:${field.name}`;

function snapshot(current) {
  const actionable = current.nodes.filter(node => node.actionable);
  return {
    obs: current.obs,
    fingerprint: [current.url, ...current.fields.map(field => `${fieldKey(field)}=${field.value}`),
      ...actionable.map(node => `${node.role} ${node.name}`).sort()].join("\n"),
    values: new Map(current.fields.map(field => [fieldKey(field), { ref: field.ref, value: field.value }])),
    refs: new Set(actionable.map(node => node.ref)),
    fieldRefs: new Set(current.fields.map(field => field.ref)),
    targets: new Map(current.nodes.map(node => [node.ref, `${node.role} ${node.name}`])),
  };
}

/** Records the batch so the next observation can compare against its start. */
export function recordBatch(tab, args, steps) {
  tab.lastBatch = { from: args.observation, steps: (args.steps ?? []).map((step, index) => ({
    action: step?.action, ref: step?.ref, point: Boolean(step?.point), value: step?.value,
    completed: steps[index]?.status === "completed" })) };
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

// The same steps on the same targets, from the same page state.
function signature(previous, batch) {
  if (batch.steps.some(step => step.point)) return null;
  return [previous.fingerprint, ...batch.steps.map(step => `${step.action} ${previous.targets.get(step.ref) ?? ""} ${step.value ?? ""}`)].join("\n");
}

function suggestions(previous, entry, batch) {
  const last = batch.steps.filter(step => step.completed).at(-1);
  if (!last || !["fill", "type"].includes(last.action)) return null;
  const appeared = [...entry.refs].filter(ref => !previous.refs.has(ref) && !entry.fieldRefs.has(ref));
  if (appeared.length < 2) return null;
  const field = last.ref ? ` into [${last.ref}]` : "";
  return `${appeared.length} new clickable options appeared right after typing${field}: ${appeared.slice(0, 12).join(", ")}${appeared.length > 12 ? ", …" : ""}. Typed text alone may not commit a choice; select the option that matches, then check the field.`;
}

function outcomes(tab, previous, entry, batch, history) {
  const notes = [];
  const lost = cleared(previous, entry, batch);
  if (lost.length) {
    const earlier = history.slice(0, -2).findLast(old => old.fingerprint === entry.fingerprint);
    notes.push(`The last batch cleared field ${lost.join(", ")}, which had a value before${earlier ? `; the page is back to its state at ${earlier.obs}` : ""}. Unless clearing was intended, this undid progress; use a different control instead.`);
  }
  // A repeat matters only when its outcome is not progress: lost values or no change.
  const unchanged = entry.fingerprint === previous.fingerprint;
  const key = signature(previous, batch), seen = tab.batchOutcomes ??= new Map();
  if (key && (lost.length || unchanged) && seen.get(key)?.fingerprint === entry.fingerprint) {
    notes.push(`This batch already ran from the same page state and led to the same result (${seen.get(key).obs}). Repeating it will not change the outcome; change approach.`);
  }
  if (key) { seen.set(key, { obs: entry.obs, fingerprint: entry.fingerprint }); if (seen.size > 50) seen.delete(seen.keys().next().value); }
  if (unchanged && domOnly(previous, batch)) {
    notes.push("The last batch changed no URL, field or control. Check the screenshot; if nothing happened, try a different control or approach instead of repeating it.");
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
