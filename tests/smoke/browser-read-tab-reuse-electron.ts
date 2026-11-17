// test-category: race
/** A turn's next page replaces a tab it already read and is not using; unread tabs and other turns' tabs stay. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp } from "../support/browser-agent-app";
import { hostResolverRules, publicResolverPatch } from "../support/signin-fixtures";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const page = new URL(request.url).pathname;
  if (page !== "/a" && page !== "/b") return new Response("Not found", { status: 404 });
  return new Response(`<!doctype html><meta charset="utf-8"><title>${page}</title><h1>${page}</h1>`, { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const page = `http://www.fixture-shop.test:${fixture.port}`;
process.env.BUTLER_SMOKE_ELECTRON_ARGS = JSON.stringify([...JSON.parse(process.env.BUTLER_SMOKE_ELECTRON_ARGS ?? "[]"), hostResolverRules()]);
const app = await browserAgentApp(evidence, () => null);
const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})`;
const execute = <T>(op: string, turn_id: string, tab?: string, args: unknown = {}) => app.main<T>(`globalThis.browserAgentSubject.execute(${JSON.stringify({ op, tab, args, session: "general", turn_id })})`);
const results: Record<string, unknown> = {};

try {
  await app.main(publicResolverPatch(module));
  await app.call("open");
  const agentTabs = async () => (await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state")).tabs.filter(tab => tab.agent).map(tab => tab.id);
  const first = await execute<{ status: string; tab: string }>("tab.open", "t1", undefined, { url: `${page}/a` });
  results.first = first;
  assert.equal(first.status, "ok", JSON.stringify(first));
  // Opened but not read yet: the next page keeps it.
  const unread = await execute<{ status: string; tab: string }>("tab.open", "t1", undefined, { url: `${page}/b` });
  results.unread = unread;
  assert.deepEqual((await agentTabs()).sort(), [first.tab, unread.tab].sort());
  const read = await execute<{ status: string }>("tab.read", "t1", first.tab);
  assert.equal(read.status, "ok", JSON.stringify(read));
  // The turn's next page replaces the tab it already read.
  const next = await execute<{ status: string; tab: string }>("tab.open", "t1", undefined, { url: `${page}/a` });
  results.next = next;
  assert.equal(next.status, "ok", JSON.stringify(next));
  assert.deepEqual((await agentTabs()).sort(), [unread.tab, next.tab].sort());
  // Another turn never closes this turn's tabs.
  await execute<{ status: string }>("tab.read", "t1", next.tab);
  const other = await execute<{ status: string; tab: string }>("tab.open", "t2", undefined, { url: `${page}/b` });
  results.other = other;
  assert.deepEqual((await agentTabs()).sort(), [unread.tab, next.tab, other.tab].sort());
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, ...results }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), results, state: await app.call("state").catch(() => null) }, null, 2));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); fixture.stop(true); }
