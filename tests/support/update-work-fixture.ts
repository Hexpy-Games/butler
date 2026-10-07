import { strict as assert } from "node:assert";
import type { ElectronPage } from "./electron-page-cdp.ts";

type AcceptedWork = {
  turn_id?: string;
  turn?: { id?: string; turn_id?: string };
  queued?: { id: string; turn_id?: string };
};

async function dispatchedUpdateTurn(page: ElectronPage, chat: string, accepted: AcceptedWork, isHeld: () => boolean) {
  let turn = accepted.turn_id ?? accepted.turn?.id ?? accepted.turn?.turn_id ?? accepted.queued?.turn_id;
  const queuedId = accepted.queued?.id;
  assert.ok(turn || queuedId, "The send must return a turn or an exact queued receipt.");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!turn) {
      const queue = await page.expression<{ queued_messages: Array<{ id: string; turn_id?: string }> }>(
        `window.butlerApp.listSessionQueue(${JSON.stringify({ sessionId: chat })})`);
      turn = queue.queued_messages.find(message => message.id === queuedId)?.turn_id;
    }
    if (turn && isHeld()) return turn;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("The accepted update fixture work was not dispatched.");
}

/** Matches the canonical current request, excluding later user-role context updates. */
export function updateFixtureWord(messages: Array<{ role?: string; content?: unknown }> = []) {
  const texts = messages.filter(message => message.role === "user").map(message => {
    if (typeof message.content === "string") return message.content;
    return Array.isArray(message.content) ? message.content.map(part => part?.text ?? "").join("\n") : "";
  });
  const text = texts.findLast(text => text.includes("User request:")) ?? texts.at(-1) ?? "";
  const start = text.lastIndexOf("User request:");
  const request = (start < 0 ? text : text.slice(start + "User request:".length)).split("Current scope:")[0];
  return /Reply with exactly the word: (one|waiting|done)/u.exec(request)?.[1];
}

export function updateFixtureResponse(body: {
  messages?: Array<{ role?: string; content?: unknown }>;
  response_format?: { json_schema?: { name?: string; strict?: boolean } };
}) {
  const schema = body.response_format?.json_schema;
  if (schema?.name === "memory_meaning_v4") {
    assert.equal(schema.strict, true);
    // Same processed-empty contract as the Rust E2E meaning stub: these
    // synthetic one-word exchanges contain no durable facts to extract.
    return { word: null, content: JSON.stringify({ status: "processed", entities: [], items: [], attributes: [] }) };
  }
  assert.ok(!schema, `Unhandled fixture schema: ${schema?.name}`);
  const word = updateFixtureWord(body.messages);
  return { word, content: word ?? "stub" };
}

/** A held local provider request keeps a real turn active across the choice. */
export function updateWorkFixture(mode: string) {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let original = "";
  let sessionId = "";
  let activeRequests = 0;
  return {
    release,
    async provider(request: Request) {
      const body = await request.json();
      const { word, content } = updateFixtureResponse(body);
      if (word === "one") {
        activeRequests += 1;
        await held;
      }
      return Response.json({ id: "update-smoke", object: "chat.completion", created: 0, model: "stub",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    },
    async start(page: ElectronPage, chat: string) {
      sessionId = chat;
      const receipt = await page.expression<{ ok: boolean; data?: AcceptedWork }>(`window.butlerApp.sendMessage(${JSON.stringify({
        chatId: chat, text: "Reply with exactly the word: one", clientMessageId: crypto.randomUUID(), model: "local/stub",
      })})`);
      assert.equal(receipt.ok, true, "The preload bridge must accept the fixture message.");
      assert.ok(receipt.data);
      original = await dispatchedUpdateTurn(page, chat, receipt.data, () => activeRequests === 1);
      assert.ok(original);
      for (const text of ["Reply with exactly the word: waiting", "Reply with exactly the word: done"]) {
        await page.expression(`window.butlerApp.queueMessage(${JSON.stringify({ chatId: chat, text, model: "local/stub" })})`);
      }
      await page.waitForFunction(() => Boolean(document.querySelector("[data-test-id='update-component-app'] button")));
    },
    async choose(page: ElectronPage) {
      await page.waitForFunction(() => Boolean(document.querySelector("[data-test-id='app-update-choice']")));
      const label = mode === "now" ? "Update now" : "Update after work finishes";
      await page.expression(`Array.from(document.querySelectorAll('[data-test-id="app-update-choice"] button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
      if (mode === "defer") {
        await page.waitForFunction(() => !document.querySelector("[data-test-id='app-update-choice']") &&
          Boolean(document.querySelector("[data-test-id='update-component-app'] button:disabled")));
        const state = await page.expression<{ status: string }>("window.butlerApp.getAppUpdateState()");
        assert.equal(state.status, "deferred");
        release();
      }
    },
    async verify(page: ElectronPage) {
      release();
      const terminal = ["delivered", "failed", "cancelled", "runtime_fault"];
      const read = () => page.expression<{ turns: Array<Record<string, unknown>> }>(
        `window.butlerApp.listTurns(${JSON.stringify({ chatId: sessionId })})`);
      const deadline = Date.now() + 30_000;
      let turns: Array<Record<string, unknown>> = [];
      while (Date.now() < deadline) {
        turns = (await read()).turns;
        if (turns.length === 3 && turns.every(t => terminal.includes(String(t.state)))) break;
        await new Promise(done => setTimeout(done, 100));
      }
      assert.equal(turns.length, 3, "active input plus both follow-ups survived");
      const first = turns.find(t => t.id === original);
      assert.ok(first);
      assert.equal(first.state, mode === "now" ? "failed" : "delivered");
      if (mode === "now") {
        assert.equal(first.safe_error_code, "turn_interrupted");
        assert.equal(first.retryable, true);
      }
      assert.equal(turns.filter(t => t.state === "delivered").length, mode === "now" ? 2 : 3);
      assert.equal(activeRequests, 1, "interrupted active work was not silently replayed");
      console.log(`WORK ${mode}: original=${first.state}, follow-ups=2 delivered, active provider calls=1`);
    },
  };
}
