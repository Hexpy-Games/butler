/** Tabs the user opens keep the user's sign-ins, in any group; pages Butler opens stay signed out. */
import { strict as assert } from "node:assert";
import { waitBrowser, type browserAgentApp } from "./browser-agent-app";

type App = Awaited<ReturnType<typeof browserAgentApp>>;
type Tab = { id: string; owner: string; profile: string; title: string; status: string; url: string };

/** A site with a sign-in: /signin sets a lasting session cookie, /account names who is signed in. */
export function signInSite() {
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
    const url = new URL(request.url);
    const signedIn = /(?:^|;\s*)sid=member/u.test(request.headers.get("cookie") ?? "");
    const page = (title: string, headers: Record<string, string> = {}) => new Response(`<!doctype html><title>${title}</title><h1>${title}</h1>`, { headers: { "content-type": "text/html", ...headers } });
    if (url.pathname === "/signin") return page("Signed in", { "set-cookie": "sid=member; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax" });
    return page(signedIn ? "Account: member" : "Account: signed out");
  } });
}

const tabs = async (app: App) => (await app.call<{ tabs: Tab[] }>("state")).tabs;

async function visit(app: App, id: string, url: string, title: string) {
  await app.call("navigate", { id, value: url });
  await waitBrowser(async () => (await tabs(app)).some((tab) => tab.id === id && tab.status === "idle" && tab.title === title), `${url} shows "${title}"`);
}

/** Opens a tab with the pane's own + (or a group's + in the Browser hub) and returns it. */
async function plusTab(app: App, selector: string, owner: string) {
  const before = new Set((await tabs(app)).map((tab) => tab.id));
  await app.page.clickSelector(selector);
  let opened: Tab | undefined;
  await waitBrowser(async () => Boolean(opened = (await tabs(app)).find((tab) => !before.has(tab.id) && tab.owner === owner)), `${selector} opens a tab in ${owner}`);
  return opened!;
}

/**
 * Signs in from a conversation tab the user opened, closes it, then opens the site again from the
 * conversation pane's + and from the Browser hub's group +: both are still signed in. A page Butler
 * opens in the same conversation stays signed out.
 */
export async function userTabsKeepSignIn(app: App, site: URL, owner: string, paneNewTab: string, groupNewTab: string, openHub: () => Promise<void>) {
  const account = new URL("/account", site).href;
  const first = await plusTab(app, paneNewTab, owner);
  assert.equal(first.profile, "signed_in", "a tab the user opens in a conversation uses the user's sign-ins");
  await visit(app, first.id, new URL("/signin", site).href, "Signed in");
  await app.call("close", { id: first.id });
  await waitBrowser(async () => !(await tabs(app)).some((tab) => tab.id === first.id), "signed-in tab closed");
  const again = await plusTab(app, paneNewTab, owner);
  await visit(app, again.id, account, "Account: member");
  // Butler's pages reach only public sites, so its profile is checked for the test site's sign-in directly.
  const agent = await app.call<string>("create", { owner, agent: true });
  assert.equal((await tabs(app)).find((tab) => tab.id === agent)?.profile, "signed_out");
  const sessions = await app.main<{ butler: number; user: number; persistent: boolean }>(`(async () => {
    const b=globalThis.browserAgentSubject, agent=b.tabs.get(${JSON.stringify(agent)}), user=b.tabs.get(${JSON.stringify(again.id)});
    b.materialize(agent);
    const count=async t=>(await t.view.webContents.session.cookies.get({ url: ${JSON.stringify(account)} })).length;
    return { butler: await count(agent), user: await count(user), persistent: agent.view.webContents.session.isPersistent() };
  })()`);
  assert.deepEqual(sessions, { butler: 0, user: 1, persistent: false }, "Butler's page has none of the user's sign-ins");
  await app.call("close", { id: agent });
  await openHub();
  const grouped = await plusTab(app, groupNewTab, owner);
  assert.equal(grouped.profile, "signed_in", "a group's + in the Browser hub uses the user's sign-ins");
  await visit(app, grouped.id, account, "Account: member");
  for (const id of [again.id, grouped.id]) await app.call("close", { id });
  await waitBrowser(async () => !(await tabs(app)).some((tab) => tab.id === again.id || tab.id === grouped.id), "sign-in tabs closed");
}
