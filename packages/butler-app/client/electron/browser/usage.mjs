// Calls fence dispatched input; holds span the owning turn/run. Neither is persisted.
export function startUse(browser, frame) {
  const use = { id: frame.id, session: frame.session, turn: frame.turn_id, tab: frame.tab };
  browser.uses.set(frame.id, use);
  holdUse(browser, use);
  browser.publish();
}
function holdUse(browser, use) {
  const tab = browser.tabs.get(use.tab);
  if (!tab || tab.holder !== "agent" || tab.owner !== `conversation:${use.session}` || typeof use.turn !== "string") return;
  const holds = browser.holds.get(tab.id) ?? new Map();
  holds.set(use.turn, use.session);
  browser.holds.set(tab.id, holds);
}
export function bindUse(browser, use, tab) {
  if (!use || browser.uses.get(use.id) !== use) return;
  use.tab = tab.id;
  holdUse(browser, use);
  browser.publish();
}
function activeCalls(browser, tab) {
  return [...browser.uses.values()].some(use => use.tab === tab.id && tab.owner === `conversation:${use.session}`);
}
function settlePointer(browser, tab) {
  if (!tab || activeCalls(browser, tab) || tab.busy) return;
  if (tabInUse(browser, tab) && tab.pointer) {
    tab.pointer = { mode: "parked", at: tab.pointer.at, steps: [] };
  } else tab.pointer = null;
  browser.pointer.sync(tab);
}
export function releaseHold(browser, tab) {
  browser.holds.delete(tab.id);
}
export function endUse(browser, id, abort = false) {
  const use = browser.uses.get(id);
  if (!use) return;
  browser.uses.delete(id);
  const tab = browser.tabs.get(use.tab);
  settlePointer(browser, tab);
  if (abort && tab) {
    // Fence the next step without invalidating receipts for dispatched input.
    tab.cancelled = true;
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
  }
  browser.publish();
}
export function finishUse(browser, session, turn) {
  const affected = new Set();
  for (const [id, holds] of browser.holds) {
    if (holds.get(turn) === session) { holds.delete(turn); affected.add(id); }
    if (!holds.size) browser.holds.delete(id);
  }
  for (const use of [...browser.uses.values()]) if (use.session === session && use.turn === turn) {
    affected.add(use.tab); endUse(browser, use.id, true);
  }
  for (const tab of browser.tabs.values()) if (tab.owner === `conversation:${session}`) {
    if (tab.waitingTurn === turn) { tab.waiting = Boolean(tab.dialog); tab.waitingTurn = null; affected.add(tab.id); }
    if (affected.has(tab.id) && !tabInUse(browser, tab)) tab.pointer = null;
  }
  browser.publish();
}
export function resetUse(browser) {
  browser.holds.clear();
  for (const use of [...browser.uses.values()]) endUse(browser, use.id, true);
  for (const tab of browser.tabs.values()) { tab.waiting = Boolean(tab.dialog); tab.waitingTurn = null; tab.pointer = null; }
  browser.publish();
}
export function closeUse(browser, tab) {
  releaseHold(browser, tab);
  for (const use of [...browser.uses.values()]) if (use.tab === tab.id) endUse(browser, use.id, true);
}
export function tabInUse(browser, tab) {
  return tab.holder === "agent" && ([...(browser.holds.get(tab.id)?.values() ?? [])].some(session => tab.owner === `conversation:${session}`) || activeCalls(browser, tab));
}
