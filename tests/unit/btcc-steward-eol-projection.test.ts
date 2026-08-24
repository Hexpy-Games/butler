import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import type { BtccTurnRequest } from
  "../../packages/butler-agent/src/agent/btcc/contracts.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import type { BtccContextDocumentWriter } from
  "../../packages/butler-agent/src/agent/btcc/turn/context-documents.ts";
import { DefaultBtccTurnPreparation } from
  "../../packages/butler-agent/src/agent/btcc/turn/prepare-turn.ts";
import { PromptAssembler } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from
  "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Steward prompt assembly reads only the data-first EOL surface", () => {
  const fixture = createFixture();
  try {
    const assembler = new PromptAssembler({
      butlerHome: fixture.butlerHome,
      butlerData: fixture.butlerData,
    });
    const assembly = assembler.buildStewardContextAssembly();

    expect(assembly.liveConfiguration).toEqual([{
      id: "eol",
      title: "Butler Operating Ethos / EOL",
      content: "DATA_EOL_V1",
      region: "live_configuration",
      projectionClass: "profile",
      scopeKind: "user",
    }]);
    expect([
      ...assembly.staticContext,
      ...assembly.runtimeState,
      ...assembly.workingContext,
      ...assembly.retrievedContext,
      ...assembly.currentInput,
    ]).toEqual([]);
    expect(assembly.references).toEqual([]);
    expect(JSON.stringify(assembly)).not.toContain("STEWARD_CONFIG_PRIVATE");
    expect(JSON.stringify(assembly)).not.toContain("BUTLER_PERSONA_PRIVATE");
    expect(JSON.stringify(assembly)).not.toContain("BUTLER_PROFILE_PRIVATE");
    expect(JSON.stringify(assembly)).not.toContain("BUTLER_RULE_PRIVATE");

    rmSync(join(fixture.butlerData, "eol.md"));
    expect(assembler.buildStewardContextAssembly().liveConfiguration[0]?.content).toBe(
      "RESOURCE_EOL_FALLBACK",
    );
  } finally {
    fixture.conversations.close();
  }
});

test("Steward Turn admission snapshots EOL while replay retains its durable ref", async () => {
  const fixture = createFixture();
  try {
    const documents = new ImmutableContextDocuments();
    const admittedTurns = new Map<string, TurnRecord>();
    const preparation = new DefaultBtccTurnPreparation({
      bindingStore: { getBySessionId: () => fixture.binding },
      conversationStore: fixture.conversations,
      butlerData: fixture.butlerData,
      promptAssembler: new PromptAssembler({
        butlerHome: fixture.butlerHome,
        butlerData: fixture.butlerData,
      }),
      contextDocuments: documents,
      turns: { findTurn: async (turnId) => admittedTurns.get(turnId) ?? null },
      wakeAuthorizations: { validateWake: async () => false },
    });
    const firstRequest = requestFor(fixture.binding, "turn-steward-eol-1");
    const first = await preparation.prepare(firstRequest);
    if (first.command.kind !== "run") throw new Error("fresh Steward command missing");
    const [firstEolRef] = first.command.context.profileRefs;
    if (!firstEolRef) throw new Error("admitted Steward EOL ref missing");

    expect(first.command.context.profileRefs).toHaveLength(1);
    expect(first.command.context.recentFeedbackRefs).toEqual([]);
    expect(documents.resolve(firstEolRef)).toContain("DATA_EOL_V1");
    expect(documents.resolve(firstEolRef)).not.toContain("BUTLER_PERSONA_PRIVATE");
    admittedTurns.set(firstRequest.turnId, turnFrom(first.command));

    writeFileSync(join(fixture.butlerData, "eol.md"), "DATA_EOL_V2", "utf8");
    const persistedBeforeReplay = documents.size;
    const replay = await preparation.prepare(firstRequest);
    expect(replay.command).toEqual({
      kind: "resume",
      turnId: firstRequest.turnId,
      recoveryAttempt: undefined,
    });
    expect(documents.size).toBe(persistedBeforeReplay);
    expect(admittedTurns.get(firstRequest.turnId)?.context.profileRefs).toEqual([firstEolRef]);
    expect(documents.resolve(firstEolRef)).toContain("DATA_EOL_V1");
    expect(documents.resolve(firstEolRef)).not.toContain("DATA_EOL_V2");

    const second = await preparation.prepare(requestFor(fixture.binding, "turn-steward-eol-2"));
    if (second.command.kind !== "run") throw new Error("later Steward command missing");
    const [secondEolRef] = second.command.context.profileRefs;
    if (!secondEolRef) throw new Error("later Steward EOL ref missing");
    expect(secondEolRef).not.toBe(firstEolRef);
    expect(documents.resolve(secondEolRef)).toContain("DATA_EOL_V2");
  } finally {
    fixture.conversations.close();
  }
});

test("Steward Turn admission fails closed when data and bundled EOL are absent", async () => {
  const fixture = createFixture();
  try {
    rmSync(join(fixture.butlerData, "eol.md"));
    rmSync(join(fixture.butlerHome, "resources", "eol.md"));
    const preparation = new DefaultBtccTurnPreparation({
      bindingStore: { getBySessionId: () => fixture.binding },
      conversationStore: fixture.conversations,
      butlerData: fixture.butlerData,
      promptAssembler: new PromptAssembler({
        butlerHome: fixture.butlerHome,
        butlerData: fixture.butlerData,
      }),
      contextDocuments: new ImmutableContextDocuments(),
      turns: { findTurn: async () => null },
      wakeAuthorizations: { validateWake: async () => false },
    });

    await expect(preparation.prepare(
      requestFor(fixture.binding, "turn-steward-eol-missing"),
    )).rejects.toThrow("subsession_context_assembly_invalid");
  } finally {
    fixture.conversations.close();
  }
});

test("Steward Turn rejects one blank EOL before durable context snapshot", async () => {
  const fixture = createFixture();
  try {
    const documents = new ImmutableContextDocuments();
    const assembler = new PromptAssembler({
      butlerHome: fixture.butlerHome,
      butlerData: fixture.butlerData,
    });
    const preparation = new DefaultBtccTurnPreparation({
      bindingStore: { getBySessionId: () => fixture.binding },
      conversationStore: fixture.conversations,
      butlerData: fixture.butlerData,
      promptAssembler: {
        buildButlerContextAssembly: (input) =>
          assembler.buildButlerContextAssembly(input),
        buildStewardContextAssembly: () => ({
          ...assembler.buildStewardContextAssembly(),
          liveConfiguration: [{
            ...assembler.buildStewardContextAssembly().liveConfiguration[0]!,
            content: "   ",
          }],
        }),
      },
      contextDocuments: documents,
      turns: { findTurn: async () => null },
      wakeAuthorizations: { validateWake: async () => false },
    });

    await expect(preparation.prepare(
      requestFor(fixture.binding, "turn-steward-eol-blank"),
    )).rejects.toThrow("subsession_context_assembly_invalid");
    expect(documents.size).toBe(0);
  } finally {
    fixture.conversations.close();
  }
});

test("Butler Turn fails before durable context snapshot when exact EOL is absent", async () => {
  const fixture = createFixture();
  try {
    rmSync(join(fixture.butlerData, "eol.md"));
    rmSync(join(fixture.butlerHome, "resources", "eol.md"));
    const documents = new ImmutableContextDocuments();
    const binding: StoredSessionBinding = {
      ...fixture.binding,
      sessionId: "butler/eol-projection",
      role: "butler",
      metadata: {},
    };
    const preparation = new DefaultBtccTurnPreparation({
      bindingStore: { getBySessionId: () => binding },
      conversationStore: fixture.conversations,
      butlerData: fixture.butlerData,
      promptAssembler: new PromptAssembler({
        butlerHome: fixture.butlerHome,
        butlerData: fixture.butlerData,
      }),
      contextDocuments: documents,
      turns: { findTurn: async () => null },
      wakeAuthorizations: { validateWake: async () => false },
    });
    const request = requestFor(binding, "turn-butler-eol-missing");
    request.route.role = "butler";

    await expect(preparation.prepare(request)).rejects.toThrow(
      "butler_eol_context_assembly_invalid",
    );
    expect(documents.size).toBe(0);
  } finally {
    fixture.conversations.close();
  }
});

test("Butler Turn rejects a misplaced duplicate EOL before durable context snapshot", async () => {
  const fixture = createFixture();
  try {
    const documents = new ImmutableContextDocuments();
    const binding: StoredSessionBinding = {
      ...fixture.binding,
      sessionId: "butler/eol-duplicate",
      role: "butler",
      metadata: {},
    };
    const assembler = new PromptAssembler({
      butlerHome: fixture.butlerHome,
      butlerData: fixture.butlerData,
    });
    const preparation = new DefaultBtccTurnPreparation({
      bindingStore: { getBySessionId: () => binding },
      conversationStore: fixture.conversations,
      butlerData: fixture.butlerData,
      promptAssembler: {
        buildStewardContextAssembly: () => assembler.buildStewardContextAssembly(),
        buildButlerContextAssembly: (input) => {
          const assembly = assembler.buildButlerContextAssembly(input);
          return {
            ...assembly,
            staticContext: [
              ...assembly.staticContext,
              { ...assembly.liveConfiguration[0]!, region: "static_context" as const },
            ],
          };
        },
      },
      contextDocuments: documents,
      turns: { findTurn: async () => null },
      wakeAuthorizations: { validateWake: async () => false },
    });
    const request = requestFor(binding, "turn-butler-eol-duplicate");
    request.route.role = "butler";

    await expect(preparation.prepare(request)).rejects.toThrow(
      "butler_eol_context_assembly_invalid",
    );
    expect(documents.size).toBe(0);
  } finally {
    fixture.conversations.close();
  }
});

class ImmutableContextDocuments implements BtccContextDocumentWriter {
  private readonly documents = new Map<string, string>();

  get size(): number {
    return this.documents.size;
  }

  persist(input: Parameters<BtccContextDocumentWriter["persist"]>[0]): string {
    const ref = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    this.documents.set(ref, input.content);
    return ref;
  }

  resolve(ref: string): string {
    const content = this.documents.get(ref);
    if (!content) throw new Error(`missing test context document: ${ref}`);
    return content;
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "btcc-steward-eol-"));
  roots.push(root);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerData, "config"), { recursive: true });
  mkdirSync(join(butlerData, "personas"), { recursive: true });
  mkdirSync(join(butlerData, "personalization"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "rules"), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(butlerHome, "resources", "eol.md"), "RESOURCE_EOL_FALLBACK", "utf8");
  writeFileSync(join(butlerData, "eol.md"), "DATA_EOL_V1", "utf8");
  writeFileSync(join(butlerData, "config", "steward.md"), "STEWARD_CONFIG_PRIVATE", "utf8");
  writeFileSync(join(butlerData, "personas", "active.md"), "BUTLER_PERSONA_PRIVATE", "utf8");
  writeFileSync(
    join(butlerData, "personalization", "profile.json"),
    JSON.stringify({ butler_nickname: "BUTLER_PROFILE_PRIVATE" }),
    "utf8",
  );
  writeFileSync(join(butlerData, "cognition", "memory", "rules", "INDEX.md"), "[Rule](core.md)", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "rules", "core.md"), "BUTLER_RULE_PRIVATE", "utf8");
  const binding = stewardBinding(workspacePath);
  return {
    root,
    butlerHome,
    butlerData,
    binding,
    conversations: new AgentConversationStore({ butlerData }),
  };
}

function stewardBinding(workspacePath: string): StoredSessionBinding {
  const now = new Date(0).toISOString();
  return {
    sessionId: "steward/eol-projection",
    role: "steward",
    workspacePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
    metadata: {
      subsession: {
        relation_id: "relation-eol",
        delegation_id: "delegation-eol",
        task_id: "task-eol",
        execution_mode: "read_only",
        mutation_scope: [],
        allowed_tools_and_effects: [
          "grep_files:workspace",
          "list_files:workspace",
          "read_file:workspace",
          "web_read:network",
          "web_search:network",
        ],
      },
    },
    lifecycleState: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function requestFor(binding: StoredSessionBinding, turnId: string): BtccTurnRequest {
  return {
    turnId,
    sessionId: binding.sessionId,
    eventId: `event-${turnId}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: binding.sessionId },
    sender: { id: "delegation-producer" },
    message: {
      id: `message-${turnId}`,
      content: "Execute the reviewed delegation packet.",
      timestamp: "2026-08-24T00:00:00.000Z",
    },
    trigger: { kind: "user_message" },
    route: {
      role: "steward",
      reason: "steward-hint",
      workspacePath: binding.workspacePath,
    },
  };
}

function turnFrom(command: Extract<Awaited<ReturnType<DefaultBtccTurnPreparation["prepare"]>>["command"], { kind: "run" }>): TurnRecord {
  return {
    turnId: command.turnId,
    sessionId: command.sessionId,
    inboxId: `inbox-${command.turnId}`,
    triggerKey: command.triggerKey,
    originalMessageId: command.message.messageId,
    originalMessage: command.message.content,
    modelSelection: command.modelSelection,
    context: command.context,
    semanticState: "delivered",
    revision: 2,
    executionFence: 1,
  };
}
