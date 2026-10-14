// test-category: pure-logic
import { expect, test } from "bun:test";
import { finishUse } from "../../packages/butler-app/client/electron/browser/usage.mjs";

type Tab = Record<string, unknown> & { id: string };

function browserWith(tabs: Tab[]) {
  const closed: string[] = [];
  const browser = {
    tabs: new Map(tabs.map(tab => [tab.id, tab])),
    holds: new Map<string, Map<string, string>>(),
    uses: new Map(),
    publish() {},
    close(id: string) { closed.push(id); browser.tabs.delete(id); },
  };
  return { browser, closed };
}

const agentTab = (id: string, extra: Record<string, unknown> = {}): Tab =>
  ({ id, owner: "conversation:chat", agent: true, holder: "agent", profile: "signed_out", openedTurn: "steward-turn", ...extra });

test("a delegated turn's end closes only the agent tabs it opened and read", () => {
  const { browser, closed } = browserWith([
    agentTab("read"),
    agentTab("acted", { acted: true }),
    agentTab("viewed", { userViewed: true }),
    agentTab("preview", { preview: "p1" }),
    agentTab("signed", { profile: "signed_in" }),
    agentTab("other-turn", { openedTurn: "butler-turn" }),
    agentTab("held"),
    { id: "mine", owner: "mine", agent: false, holder: "user", openedTurn: "steward-turn" },
    agentTab("other-chat", { owner: "conversation:other" }),
  ]);
  browser.holds.set("held", new Map([["other-turn", "chat"]]));
  finishUse(browser, "chat", "steward-turn", true);
  expect(closed).toEqual(["read"]);
});

test("a turn that answers the user keeps the tabs it opened", () => {
  const { browser, closed } = browserWith([agentTab("read")]);
  finishUse(browser, "chat", "steward-turn", false);
  finishUse(browser, "chat", "steward-turn");
  expect(closed).toEqual([]);
  expect(browser.tabs.has("read")).toBe(true);
});
