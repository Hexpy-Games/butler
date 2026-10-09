// Execution uses are independent of tab permission and never persisted.
export function startUse(browser, frame) {
  browser.uses.set(frame.id, { id: frame.id, session: frame.session, turn: frame.turn_id, tab: frame.tab });
  browser.publish();
}
export function endUse(browser, id, abort = false) {
  const use = browser.uses.get(id);
  if (!use) return;
  browser.uses.delete(id);
  const tab = browser.tabs.get(use.tab);
  if (abort && tab) {
    // Fence the next step without invalidating receipts for dispatched input.
    tab.cancelled = true;
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
  }
  browser.publish();
}
export function finishUse(browser, session, turn) {
  for (const use of [...browser.uses.values()]) if (use.session === session && use.turn === turn) endUse(browser, use.id, true);
  for (const tab of browser.tabs.values()) if (tab.owner === `conversation:${session}` && tab.waitingTurn === turn) {
    tab.waiting = false; tab.waitingTurn = null;
  }
  browser.publish();
}
export function resetUse(browser) {
  for (const use of [...browser.uses.values()]) endUse(browser, use.id, true);
  for (const tab of browser.tabs.values()) { tab.waiting = false; tab.waitingTurn = null; }
  browser.publish();
}
export function closeUse(browser, tab) {
  for (const use of [...browser.uses.values()]) if (use.tab === tab.id) endUse(browser, use.id, true);
}
export function tabInUse(browser, tab) {
  return [...browser.uses.values()].some(use => use.tab === tab.id && tab.owner === `conversation:${use.session}`);
}
