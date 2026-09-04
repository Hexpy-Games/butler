import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGuidedToolJournal } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-tool-journal.ts";
import { SqlitePrincipalAuthorityRepository } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/authority-repository.ts";
import { createPrincipalAuthority } from "../../packages/butler-agent/src/agent/btcc/authority/index.ts";
import { restoredAuthorityToolCall } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-authority-continuation.ts";
import { createGuidedToolExecutionBoundary } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-execution-boundary.ts";
import { prepareGuidedWorkspaceFileEdit } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-edit-effect.ts";
import { guidedProjectLedgerEffect } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-project-ledger-effect-input.ts";
import { guidedToolDefinition } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-definition.ts";
import { runBtccAgentLoop } from "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { prepareBtccToolCall } from "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-execution.ts";
import { editFileToolDefinition, executeEditFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/edit_file/index.ts";
import { toolCallToolDefinition } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_call/definition.ts";
import { projectLedgerNativeToolDefinitions } from "../../packages/butler-agent/src/agent/tools/project-ledger/native.ts";
import { normalizeGuidedToolCall } from "../../packages/butler-agent/src/agent/tools/tool-call-normalization.ts";
import type { DurableWorkService } from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { GuidedEffectTestFixture, reviewedWork } from "./support/guided-effect-test-fixture.ts";

for (const batch of [false, true]) {
  test(`approved ${batch ? "batch" : "single"} edit restores the public invocation before the model`, async () => {
    const fixture = new GuidedEffectTestFixture();
    const workspace = mkdtempSync(join(tmpdir(), "butler-authority-edit-"));
    const work = seedWork(fixture);
    const journal = new SqliteGuidedToolJournal(fixture.db);
    const authority = createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(fixture.db));
    let dispatches = 0;
    writeFileSync(join(workspace, "file.txt"), "one\ntwo\n");
    writeFileSync(join(workspace, "other.txt"), "two\n");
    const edits = [
      { path: "file.txt", old_text: "one", new_text: "first" },
      { path: "other.txt", old_text: "two", new_text: "second" },
    ];
    const args = batch ? { edits } : edits[0]!;
    const definition = guidedToolDefinition(editFileToolDefinition);
    const boundary = (turnId: string, continuation?: { requestRef: string; scheduleClientMessageId: string }) => createGuidedToolExecutionBoundary({
      durableWork: { boundWorkForTurn: async () => work } as unknown as DurableWorkService,
      workScope: { turnId, sessionId: work.sessionId },
      effectService: fixture.service(),
      authority,
      toolJournal: journal,
      ownerSessionId: "owner",
      sourceSessionId: work.sessionId,
      sourceTurnId: turnId,
      workspacePath: workspace,
      modelRef: "openai/gpt-5.6-luna",
      reasoningEffort: "max",
      ...(continuation ? { authorityRequestRef: continuation.requestRef, authorityClientMessageId: continuation.scheduleClientMessageId } : {}),
      accessMode: "ask_first",
      signal: new AbortController().signal,
      executeCommand: async () => ({ ok: true }),
      resolvePersistentEffect: async (call) => {
        const prepared = await prepareGuidedWorkspaceFileEdit({
          args: call.args,
          workspacePath: workspace,
          executeEditFile: async (input) => {
            dispatches += 1;
            return executeEditFileTool({ args: input }, { workspacePath: workspace });
          },
        });
        return prepared.ok ? prepared.effect : { error: prepared.error };
      },
    });
    try {
      const raw = batch ? { id: "native:edit_file", arguments: args } : args;
      journal.start({ turnId: "source", callId: "original", toolName: "edit_file", arguments: args, rawArguments: JSON.stringify(raw) });
      const pending = await boundary("source")({
        call: { name: "edit_file", args, rawArguments: JSON.stringify(args) },
        context: { effectOccurrenceId: "original" },
        definition,
        execute: async () => ({ ok: true }),
      });
      expect(pending).toMatchObject({ authority_pending: true });
      // Allow can arrive after admission while journal completion is in flight.
      if (!batch) journal.finish({ callId: "original", status: "completed", result: pending });
      const request = authority.list({ ownerSessionId: "owner" })[0]!;
      const decision = authority.decide({ ownerSessionId: "owner", requestRef: request.request_ref, action: "allow" });
      const restored = restoredAuthorityToolCall({
        authority, toolJournal: journal, ownerSessionId: "owner",
        sourceSessionId: work.sessionId, turnId: "resumed",
        requestRef: decision.requestRef, clientMessageId: decision.scheduleClientMessageId,
      });
      expect(restored?.name).toBe(batch ? "tool_call" : "edit_file");
      expect(restored?.arguments).toEqual(raw);
      const executeBoundary = boundary("resumed", decision);
      const output = await runBtccAgentLoop({
        prompt: "Continue the approved operation.",
        tools: [definition, toolCallToolDefinition],
        resumedToolCall: restored,
        executeTool: async (call) => {
          const effective = normalizeGuidedToolCall({ toolName: call.name, args: call.arguments });
          return executeBoundary({
            call: { name: effective.name, args: effective.args, rawArguments: JSON.stringify(effective.args) },
            definition,
            context: { effectOccurrenceId: call.id },
            execute: async () => ({ ok: true }),
          });
        },
        modelRound: { async runRound(modelRequest) {
          expect(modelRequest.messages.filter((message) => message.role === "tool")
            .map((message) => JSON.parse(message.content))).toMatchObject([{ ok: true }]);
          expect(dispatches).toBe(1);
          expect(readFileSync(join(workspace, "file.txt"), "utf8")).toBe("first\ntwo\n");
          expect(readFileSync(join(workspace, "other.txt"), "utf8")).toBe(batch ? "second\n" : "two\n");
          expect(modelRequest.messages.some((message) => message.role === "tool" && message.content.includes('"ok":true'))).toBe(true);
          return { text: "Edit completed.", toolCalls: [] };
        } },
      });
      expect(output.finalText).toBe("Edit completed.");
      expect(dispatches).toBe(1);
      expect(authority.execution({ ownerSessionId: "owner", sourceSessionId: work.sessionId, requestRef: decision.requestRef, clientMessageId: decision.scheduleClientMessageId, turnId: "resumed" }).outcome).toBe("applied");
    } finally {
      fixture.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("Ledger authority restores original public fields instead of normalized internal fields", () => {
  const fixture = new GuidedEffectTestFixture();
  const work = seedWork(fixture);
  const journal = new SqliteGuidedToolJournal(fixture.db);
  const authority = createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(fixture.db));
  const args = { kind: "work", id: "W-EXAMPLE", title: "Example", status: "proposed", body: "Do the assigned work.", acceptance: "The assigned change is delivered." };
  const effect = guidedProjectLedgerEffect("project_ledger_create", args);
  expect(effect.normalizedInput).toHaveProperty("operation", "create");
  expect(effect.normalizedInput).toHaveProperty("specExemption", true);
  try {
    const raw = { id: "native:project_ledger_create", arguments: args };
    journal.start({ turnId: "source", callId: "ledger-original", toolName: "project_ledger_create", arguments: args, rawArguments: JSON.stringify(raw) });
    journal.finish({ callId: "ledger-original", status: "completed", result: { ok: true, authority_pending: true } });
    const pending = authority.admit({
      ownerSessionId: "owner", sourceSessionId: work.sessionId, sourceTurnId: "source", sourceWorkId: work.workId,
      workspacePath: "/workspace", planRevisionId: "plan", actionKey: "accepted-plan", authorityGeneration: 1,
      capability: "project_ledger_create", target: effect.target,
      category: "reviewed_effect", operationOccurrenceId: "ledger-original", normalizedInput: effect.normalizedInput,
      modelRef: "openai/gpt-5.6-luna", reasoningEffort: "max",
    });
    const decision = authority.decide({ ownerSessionId: "owner", requestRef: pending.requestRef, action: "allow" });
    const restored = restoredAuthorityToolCall({ authority, toolJournal: journal, ownerSessionId: "owner", sourceSessionId: work.sessionId,
      requestRef: decision.requestRef, clientMessageId: decision.scheduleClientMessageId, turnId: "resumed" });
    expect(restored?.arguments).toEqual(raw);
    expect(prepareBtccToolCall({ tools: [toolCallToolDefinition] }, restored!).validationError).toBeNull();
    const effective = normalizeGuidedToolCall({ toolName: restored!.name, args: restored!.arguments });
    const definition = projectLedgerNativeToolDefinitions.find((tool) => tool.name === effective.name)!;
    expect(prepareBtccToolCall({ tools: [definition] }, { ...restored!, name: effective.name, arguments: effective.args, rawArguments: JSON.stringify(effective.args) }).validationError).toBeNull();
    expect(guidedProjectLedgerEffect(effective.name, effective.args).normalizedInput).toEqual(effect.normalizedInput);
  } finally {
    fixture.close();
  }
});

function seedWork(fixture: GuidedEffectTestFixture) {
  const work = reviewedWork({ actions: [{ actionKey: "deliver", description: "Deliver the requested change", dependencyKeys: [], effect: { capability: "workspace mutation", target: "workspace deliverables" } }] });
  fixture.db.query(`INSERT INTO btcc_guided_works (
    work_id, session_id, scope_kind, scope_ref, origin_turn_id,
    origin_message_id, objective, status, created_at, updated_at
  ) VALUES (?, ?, 'session', ?, ?, ?, ?, 'open', ?, ?)`).run(
    work.workId, work.sessionId, work.sessionId, work.origin.turnId,
    work.origin.messageId, work.objective, work.createdAt, work.updatedAt,
  );
  return work;
}
