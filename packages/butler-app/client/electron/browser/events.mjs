/** Change-driven events are drained only by their conversation's next tool call. */
export function browserEvent(browser, tab, type, data = {}) {
  if (!tab.owner.startsWith("conversation:")) return;
  browser.events ??= new Map();
  const events = browser.events.get(tab.owner) ?? [];
  events.push({ type, tab: tab.id, epoch: tab.epoch, ...data });
  browser.events.set(tab.owner, events);
}
export function drainEvents(browser, frame, result) {
  if (!result || !frame.session || frame.op.startsWith("use.") || ["tab.prepare", "tab.waiting", "tab.cancel", "owner.closed"].includes(frame.op) || result.status === "dialog_pending") return result;
  const owner = `conversation:${frame.session}`;
  const events = browser.events?.get(owner);
  if (events?.length) { result.events = events; browser.events.delete(owner); }
  return result;
}
