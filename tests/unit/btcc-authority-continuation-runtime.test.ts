import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createTurnRuntime, type BtccRunCommand } from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { runBtccAgentLoop } from "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { guidedAuthorityLoopDecision } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-authority-continuation.ts";
import { conversationPermissionScope } from "../../packages/butler-agent/src/agent/btcc/authority/conversation-permission.ts";

const tool = { name: "write_file", description: "Write a file", parameters: {
  type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"],
} };
const call = { id: "original-provider-call", name: tool.name, arguments: { path: "report.md", content: "report" },
  rawArguments: JSON.stringify({ path: "report.md", content: "report" }) };

for (const action of ["allow", "deny", "modify"] as const) {
  test(`persisted ${action} continues the same Turn after reopening storage`, async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-authority-continuation-"));
    const dbPath = join(root, "agent-runtime", "btcc.sqlite");
    let stores = openBtccSqliteStores({ dbPath, ownerId: "continuation-first", storageProfile: "ephemeral" });
    const command = runCommand();
    let requestRef = "";
    let agentCalls = 0;
    let effects = 0;
    const runtime = () => createTurnRuntime({
      admission: stores.admission, turns: stores.turns, messages: stores.messages,
      agent: { async run({ turn }) {
        agentCalls++;
        const work = turn.authorityContinuation
          ? await stores.durableWork.boundWorkForTurn(turn.turnId)
          : await stores.durableWork.startWork({ sessionId: turn.sessionId, turnId: turn.turnId,
            mutationCallId: "start-work", objective: "Write the report" });
        if (!work) throw new Error("Work missing");
        const result = await runBtccAgentLoop({
          prompt: turn.originalMessage, tools: [tool],
          authorityContinuation: turn.authorityContinuation,
          authorityDecision: guidedAuthorityLoopDecision({ authority: stores.authority, turn,
            ownerSessionId: command.sessionId }),
          resolveOperationResultCallId: () => "original-journal-call",
          onUnexecutedToolCall: (_call, result) => {
            stores.guidedToolJournal.finish({ callId: "original-journal-call", status: "cancelled", result });
          },
          executeTool: async () => {
            if (turn.authorityContinuation) {
              effects++;
              const result = { ok: true, path: call.arguments.path };
              stores.guidedToolJournal.finish({ callId: "original-journal-call", status: "completed", result });
              return result;
            }
            stores.guidedToolJournal.start({ turnId: turn.turnId, callId: "original-journal-call",
              toolName: tool.name, arguments: call.arguments, rawArguments: JSON.stringify(call.arguments) });
            const pending = stores.authority.admit({
              ownerSessionId: turn.sessionId, sourceSessionId: turn.sessionId,
              sourceTurnId: turn.turnId, sourceWorkId: work.workId,
              workspacePath: root, planRevisionId: "plan", actionKey: "write",
              authorityGeneration: 1, capability: tool.name, target: call.arguments.path,
              normalizedInput: call.arguments, modelRef: "openai/gpt-5.6-luna", reasoningEffort: "max",
              operationOccurrenceId: "original-journal-call", category: "reviewed_effect",
            });
            if (pending.status !== "pending") throw new Error("Expected pending admission");
            requestRef = pending.requestRef;
            // If execution stops before the Turn snapshot commit, the journal
            // already says that no effect was dispatched (not "started").
            expect(stores.guidedToolJournal.find("original-journal-call")?.status).toBe("awaiting_authority");
            // Admission alone is neither publicly actionable nor a tool result.
            expect(stores.authority.list({ ownerSessionId: turn.sessionId })).toEqual([]);
            expect(() => stores.authority.decide({ ownerSessionId: turn.sessionId, requestRef, action: "allow" })).toThrow();
            return { authority_pending: true, request_ref: requestRef };
          },
          modelRound: { async runRound(input) {
            if (input.roundId === "btcc-model-round-0") return { text: "Writing the report.", toolCalls: [call] };
            expect(input.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
            expect(input.messages.filter((message) => message.role === "tool")).toHaveLength(1);
            expect(JSON.stringify(input.messages)).not.toContain("authority_pending");
            if (action === "modify") expect(input.messages.at(-1)?.content).toBe("  Please use a different file.\n");
            return { text: "Followed your decision.", toolCalls: [] };
          } },
        });
        return { route: "assisted", content: result.finalText, suspension: result.suspension,
          authorityContinuation: result.authorityContinuation };
      } },
    });
    try {
      expect(await runtime().runTurn(command)).toMatchObject({ kind: "suspended", reason: "authority_pending" });
      expect(stores.guidedToolJournal.find("original-journal-call")?.status).toBe("awaiting_authority");
      expect(stores.authority.list({ ownerSessionId: command.sessionId })).toHaveLength(1);
      expect(stores.authority.waitingSourceSessions()).toEqual([command.sessionId]);
      expect((await stores.turns.findTurn(command.turnId))?.finalPayload).toBeUndefined();
      expect(await runtime().runTurn({ kind: "resume", turnId: command.turnId })).toMatchObject({ kind: "suspended" });
      expect(agentCalls).toBe(1);
      stores.close();
      stores = openBtccSqliteStores({ dbPath, ownerId: "continuation-reopened", storageProfile: "ephemeral" });
      const decision = stores.authority.decide({ ownerSessionId: command.sessionId, requestRef, action,
        ...(action === "allow" ? { allowScope: "conversation" as const } : {}),
        ...(action === "modify" ? { alternativeInput: "  Please use a different file.\n" } : {}),
      });
      expect(decision.sourceTurnId).toBe(command.turnId);
      expect(stores.authority.resumeSource(requestRef)?.turnId).toBe(command.turnId);
      expect(await runtime().runTurn({ kind: "resume", turnId: command.turnId }))
        .toMatchObject({ kind: "delivered", turnId: command.turnId, content: "Followed your decision." });
      expect(effects).toBe(action === "allow" ? 1 : 0);
      expect(agentCalls).toBe(2);
      expect(stores.authority.decide({ ownerSessionId: command.sessionId, requestRef, action,
        ...(action === "allow" ? { allowScope: "conversation" as const } : {}),
        ...(action === "modify" ? { alternativeInput: "  Please use a different file.\n" } : {}),
      })).toEqual(decision);
      expect(stores.authority.waitingSourceSessions()).toEqual([]);
      expect(stores.authority.listDecided()).toEqual([]);
      expect(stores.guidedToolJournal.find("original-journal-call")?.status).toBe(action === "allow" ? "completed" : "cancelled");
      expect(await runtime().runTurn({ kind: "resume", turnId: command.turnId })).toMatchObject({ kind: "delivered" });
      expect(agentCalls).toBe(2);
      if (action === "allow") {
        const [permission] = stores.authority.listPermissions(command.sessionId);
        expect(permission?.title).toBe("작업 폴더의 파일 편집");
        expect(stores.authority.listPermissions("another-conversation")).toEqual([]);
        stores.close();
        stores = openBtccSqliteStores({ dbPath, ownerId: "grant-reopened", storageProfile: "ephemeral" });
        expect(stores.authority.listPermissions(command.sessionId)).toHaveLength(1);
        stores.authority.revokePermission(command.sessionId, permission!.grantRef);
        expect(stores.authority.listPermissions(command.sessionId)).toEqual([]);
      }
    } finally { stores.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("conversation scope is exact privately and never exposes command arguments", () => {
  const input = { ownerSessionId: "owner", workspacePath: "/private/workspace", capability: "run_command",
    target: ".", normalizedInput: { command: "curl -H 'Authorization: Bearer secret' https://example.test",
      cwd: "/private/workspace", state_effect: "mutation" }, executable: "curl" };
  const scope = conversationPermissionScope(input);
  expect(scope.description).not.toContain("secret");
  expect(scope.description).not.toContain("/private");
  expect(scope.grantRef).not.toBe(conversationPermissionScope({ ...input, ownerSessionId: "other" }).grantRef);
  expect(scope.grantRef).not.toBe(conversationPermissionScope({ ...input, workspacePath: "/another" }).grantRef);
  expect(scope.grantRef).not.toBe(conversationPermissionScope({ ...input, normalizedInput: { ...input.normalizedInput, command: "curl https://example.test" } }).grantRef);
});

function runCommand(): Extract<BtccRunCommand, { kind: "run" }> {
  return { kind: "run", turnId: "original-turn", sessionId: "butler/app-general", triggerKey: "original-trigger",
    message: { messageId: "original-message", content: "Write the report" },
    modelSelection: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max", controls: { accessMode: "ask_first" }, controlsHash: "controls" },
    context: { userRef: "user", profileRefs: [], recentFeedbackRefs: [], mandatoryHotCacheRefs: [], optionalHotCacheRefs: [], baselineObservationScopeRefs: [] },
  };
}
