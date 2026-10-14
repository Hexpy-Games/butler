// The routing key while a turn drives the event's tab; never sent out.
const TURN = Symbol("turn");
/** Change-driven events are drained only by their conversation's next tool call;
 * an event of a tab a running turn drives waits for that turn's call, so
 * parallel turns of one conversation (delegated work) never take each other's. */
export function browserEvent(browser, tab, type, data = {}) {
  if (!tab.owner.startsWith("conversation:")) return;
  browser.events ??= new Map();
  const events = browser.events.get(tab.owner) ?? [];
  events.push({ type, tab: tab.id, epoch: tab.epoch, ...data, ...(tab.turn ? { [TURN]: tab.turn } : {}) });
  browser.events.set(tab.owner, events);
}
export function drainEvents(browser, frame, result) {
  if (!result || !frame.session || frame.op.startsWith("use.") || ["tab.prepare", "tab.waiting", "tab.cancel", "owner.closed"].includes(frame.op) || result.status === "dialog_pending") return result;
  const owner = `conversation:${frame.session}`;
  const events = browser.events?.get(owner);
  if (!events?.length) return result;
  const driving = turn => [...browser.tabs.values()].some(tab => tab.owner === owner && tab.turn === turn);
  const mine = event => !event[TURN] || event[TURN] === frame.turn_id || !driving(event[TURN]);
  const taken = events.filter(mine), kept = events.filter(event => !mine(event));
  if (kept.length) browser.events.set(owner, kept); else browser.events.delete(owner);
  if (taken.length) result.events = taken.map(({ [TURN]: _turn, ...event }) => event);
  return result;
}
/** A finished turn drives no tab; its undelivered events go to the conversation's next call. */
export function releaseTurnEvents(browser, session, turn) {
  const owner = `conversation:${session}`;
  for (const tab of browser.tabs.values()) if (tab.owner === owner && tab.turn === turn) tab.turn = undefined;
  for (const event of browser.events?.get(owner) ?? []) if (event[TURN] === turn) delete event[TURN];
}
