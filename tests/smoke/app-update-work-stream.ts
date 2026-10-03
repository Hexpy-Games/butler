/** Deferred updates follow real committed work events, including the full FIFO. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { updateFixtureResponse } from "../support/update-work-fixture.ts";
import { createAppUpdateCoordinator } from "../../packages/butler-app/client/electron/app-foreground-update.mjs";
import { watchAppUserWork } from "../../packages/butler-app/client/electron/app-user-work-events.mjs";
import { confirmAppForegroundQuit, type AppForegroundActiveWorkSnapshot } from "../../packages/butler-app/client/electron/app-foreground-quit.mjs";

let release = () => {};
const held = new Promise<void>(resolve => { release = resolve; });
let requests = 0;
const server = await createNativeAppServer({ env: { BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP: "1" }, stubReply: async (call) => {
  const { word, content } = updateFixtureResponse(call.body);
  if (word) {
    if (++requests === 1) await held;
  }
  return content;
} });
let chatId = "";
let activate = () => {};
let fail = (_error: Error) => {};
const activated = new Promise<void>((resolve, reject) => { activate = resolve; fail = reject; });
let choiceReady = () => {};
const choiceRequired = new Promise<void>(resolve => { choiceReady = resolve; });
let timer: ReturnType<typeof setTimeout> | undefined;
let activations = 0;
let reads = 0;
let wakes = 0;
const streamStatuses: number[] = [];
const coordinator = createAppUpdateCoordinator({
  readActiveWork: () => { reads += 1; return server.api("/user-work"); },
  watchWork: (onChange) => watchAppUserWork({
    connect: async signal => {
      const response = await fetch(new URL("events/live", server.url), { signal, headers: server.authHeaders });
      streamStatuses.push(response.status);
      return response;
    },
    onChange: () => { wakes += 1; onChange(); },
  }),
  stopForUpdate: async () => {
    const { turns } = await server.api<{ turns: Array<{ state: string }> }>(`/turns?chat_id=${chatId}`);
    assert.equal(turns.length, 3, "all accepted work remains visible");
    assert.ok(turns.every(turn => turn.state === "delivered"), "defer waits for the entire FIFO");
    await server.stop();
    return { update_ready: true };
  },
  onState: state => {
    if (state.status === "choice_required") choiceReady();
    if (state.status === "failed") fail(new Error("deferred update failed"));
  },
});
try {
  const idle = await server.api<Pick<AppForegroundActiveWorkSnapshot, "classification">>("/user-work");
  assert.equal(idle.classification, "no_active_work");
  assert.ok(await confirmAppForegroundQuit({ snapshot: idle,
    showMessageBox: async () => { throw new Error("background bootstrap prompted quit"); },
  }));
  writeFileSync(join(server.butlerData, "state/e2e-memory-bootstrap-release"), "");
  const { session } = await server.api<{ session: { id: string } }>("/sessions", {
    method: "POST", body: JSON.stringify({ kind: "chat", title: "Update work" }),
  });
  chatId = session.id;
  await server.api("/messages", { method: "POST", body: JSON.stringify({
    chat_id: chatId, text: "Reply with exactly the word: one", client_message_id: crypto.randomUUID(), model: "local/stub",
  }) });
  for (const text of ["Reply with exactly the word: waiting", "Reply with exactly the word: done"]) {
    await server.api("/session-queue", { method: "POST", body: JSON.stringify({
      chat_id: chatId, text, client_message_id: crypto.randomUUID(), model: "local/stub",
    }) });
  }
  const initial = await server.api<{ active_turn_count: number; queued_message_count: number }>("/user-work");
  assert.equal(initial.active_turn_count, 1);
  assert.equal(initial.queued_message_count, 2);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("committed work did not activate deferred update")), 30_000);
  });
  const update = coordinator.request(async () => ({
    activate: () => { activations += 1; activate(); },
    cancel: () => { throw new Error("settled update should not cancel"); },
  }));
  await Promise.race([choiceRequired, activated, deadline]);
  assert.equal(coordinator.state().status, "choice_required");
  assert.ok(coordinator.choose({ request_id: coordinator.state().request_id, action: "defer" }).ok);
  assert.equal((await update).status, "deferred");
  assert.equal(activations, 0);
  release();
  await Promise.race([activated, deadline]);
  assert.equal(activations, 1);
  assert.equal(requests, 3);
  console.log("PASS background-only quit and real authenticated SSE: three turns delivered; deferred activation once after native shutdown");
} catch (error) {
  const view = await server.api("/user-work");
  const { turns } = await server.api<{ turns: Array<{ state: string }> }>(`/turns?chat_id=${chatId}`);
  console.error({ reads, wakes, streamStatuses, requests, status: coordinator.state().status,
    view, turnStates: turns.map(turn => turn.state) });
  const db = new Database(join(server.butlerData, "app-server/butler-client.sqlite"), { readonly: true });
  console.error({ rows: db.query("SELECT t.chat_id=? AS fixture,t.state,c.kind,t.safe_error_code,json_extract(t.execution_controls_json,'$.model_ref') AS model FROM turns t JOIN chats c ON c.id=t.chat_id").all(chatId),
    queue: db.query("SELECT chat_id=? AS fixture,state,turn_id IS NULL AS unclaimed FROM session_queued_messages").all(chatId) });
  db.close();
  const btcc = new Database(join(server.butlerData, "agent-runtime/btcc.sqlite"), { readonly: true });
  console.error({ modelErrors: btcc.query("SELECT error_code,failure_disposition,COUNT(*) AS count FROM btcc_model_route_events GROUP BY error_code,failure_disposition").all(),
    semanticStates: btcc.query("SELECT semantic_state,suspension_reason,COUNT(*) AS count FROM btcc_turns GROUP BY semantic_state,suspension_reason").all() });
  btcc.close();
  throw error;
} finally {
  clearTimeout(timer);
  release();
  coordinator.dispose();
  await server.stop();
}
