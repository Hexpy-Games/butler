import { expect, test, spyOn } from "bun:test";
import { prepareGuidedConversationBranchEffect } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-conversation-branch-effect.ts";

test("reviewed branch dispatch and response-loss reconciliation use the same durable request identity", async () => {
  const calls: Record<string, unknown>[] = [];
  const replacement = async (_url: URL | RequestInfo, options?: RequestInit) => {
    calls.push(JSON.parse(String(options?.body)));
    if (calls.length === 1) throw new Error("connection lost after server reservation");
    return new Response(JSON.stringify({ data: { session_id: "same-target", started: false } }));
  };
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(replacement, { preconnect: globalThis.fetch.preconnect }));
  try {
    const prepared = prepareGuidedConversationBranchEffect({ butlerData: "/tmp", appSessionId: "general",
      args: { title: "보험", destination: "chat" } });
    expect(prepared.adapter.reviewedPlanBinding).toBe("accepted_plan");
    const effect = { normalizedInput: prepared.input, normalizedTarget: prepared.target,
      idempotencyKey: "effect-owned-identity", signal: new AbortController().signal };
    expect((await prepared.adapter.dispatch(effect)).status).toBe("uncertain");
    expect(await prepared.adapter.reconcile({ ...effect, dispatchAttempts: 1 })).toEqual({
      status: "applied", result: { session_id: "same-target", started: false },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]?.request_id).toBe(effect.idempotencyKey);
    expect(calls[0]?.current_session_id).toBe("general");
    const abort = new AbortController(); abort.abort();
    expect((await prepared.adapter.dispatch({ ...effect, signal: abort.signal })).status).toBe("not_applied");
    expect(calls).toHaveLength(2);
  } finally { transport.mockRestore(); }
});
