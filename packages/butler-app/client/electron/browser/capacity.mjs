import { totalmem } from "node:os";
import { tabInUse } from "./usage.mjs";

// How many tabs the browser holds, as the Agent's `browser::capacity` sizes
// them: the user's own tabs, and agent tabs by installed memory (one per GiB,
// 6 to 24; a page's renderer commonly holds a few hundred MB). Agent tabs are
// shared by every conversation, so several conversations (and a
// conversation's parallel tabs) browse at once.
export const USER_TABS = 30;
export const AGENT_TABS = Math.min(24, Math.max(6, Math.floor(totalmem() / 2 ** 30)));
export const MAX_TABS = USER_TABS + AGENT_TABS;

/** Whether one more agent (or Butler-driven) tab fits. */
export function agentTabFits(browser) {
  let count = 0;
  for (const tab of browser.tabs.values()) if (tab.agent || tab.driven) count++;
  return count < AGENT_TABS;
}

/** Room for one more agent tab: when every slot is taken, the least recently
 * used agent tab that no call, turn, wait or dialog holds and the user is not
 * viewing closes first, as its idle expiry would. False only while every agent
 * tab is in use. */
export function makeAgentRoom(browser, keep) {
  if (agentTabFits(browser)) return true;
  const idle = [...browser.tabs.values()].filter(tab => tab.agent && tab.holder === "agent" && tab !== keep && !tab.closing && !tab.busy
    && !tab.dialog && !tab.waiting && !tab.viewed && !tab.userViewed && !tabInUse(browser, tab));
  const oldest = idle.sort((a, b) => (a.lastAgentCall ?? 0) - (b.lastAgentCall ?? 0))[0];
  if (oldest) browser.close(oldest.id);
  return agentTabFits(browser);
}
