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
import { inboundEnvelopeFor } from
  "../../packages/butler-agent/src/agent/btcc/turn/prepare-turn-request.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { snapshotChildProjectContext } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/project-context.ts";
import { addFeedbackEntry } from
  "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import type { ModelRoundRequest } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER } from
  "../support/phase-continuity-private-digester.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Steward shares system context without Butler personalization", () => {
  const fixture = createFixture();
  try {
    const assembler = new PromptAssembler({
      butlerHome: fixture.butlerHome,
      butlerData: fixture.butlerData,
    });
    const input = { binding: fixture.binding, envelope: inboundEnvelopeFor(requestFor(fixture.binding, "assembly")) };
    const assembly = assembler.buildStewardContextAssembly(input);

    expect(assembly.liveConfiguration).toContainEqual({
      id: "eol",
      title: "Butler Operating Ethos / EOL",
      content: "DATA_EOL_V1",
      region: "live_configuration",
      projectionClass: "profile",
      scopeKind: "user",
    });
    expect([
      ...assembly.workingContext,
      ...assembly.retrievedContext,
      ...assembly.currentInput,
    ]).toEqual([]);
    expect(assembly.references).toEqual([]);
    expect(JSON.stringify(assembly)).not.toContain("STEWARD_CONFIG_PRIVATE");
    expect(JSON.stringify(assembly)).not.toContain("BUTLER_PERSONA_PRIVATE");
    expect(JSON.stringify(assembly)).not.toContain("BUTLER_PROFILE_PRIVATE");
    expect(JSON.stringify(assembly)).toContain("SHARED_USER_RULE");
    expect(JSON.stringify(assembly)).toContain("RUNTIME_CONTRACT_SHARED");
    expect(JSON.stringify(assembly)).toContain("Current Time UTC: 2026-08-24T00:00:00.000Z");

    rmSync(join(fixture.butlerData, "eol.md"));
    expect(assembler.buildStewardContextAssembly(input).liveConfiguration[0]?.content).toBe(
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
    const firstEolRef = first.command.context.profileRefs.find((ref) => documents.resolve(ref).includes("DATA_EOL_V1"));
    if (!firstEolRef) throw new Error("admitted Steward EOL ref missing");

    expect(first.command.context.profileRefs).toHaveLength(2);
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
    expect(admittedTurns.get(firstRequest.turnId)?.context.profileRefs).toContain(firstEolRef);
    expect(documents.resolve(firstEolRef)).toContain("DATA_EOL_V1");
    expect(documents.resolve(firstEolRef)).not.toContain("DATA_EOL_V2");

    const nextRequest = requestFor(fixture.binding, "turn-steward-eol-2");
    nextRequest.message.timestamp = "2026-09-03T01:02:03.000Z";
    const second = await preparation.prepare(nextRequest);
    if (second.command.kind !== "run") throw new Error("later Steward command missing");
    const secondEolRef = second.command.context.profileRefs.find((ref) => documents.resolve(ref).includes("DATA_EOL_V2"));
    if (!secondEolRef) throw new Error("later Steward EOL ref missing");
    expect(secondEolRef).not.toBe(firstEolRef);
    expect(documents.resolve(secondEolRef)).toContain("DATA_EOL_V2");
    const contextText = (turn: TurnRecord) => turn.context.mandatoryHotCacheRefs.map((ref) => documents.resolve(ref)).join("\n");
    expect(contextText(admittedTurns.get(firstRequest.turnId)!)).toContain("2026-08-24T00:00:00.000Z");
    expect(contextText(turnFrom(second.command))).toContain("2026-09-03T01:02:03.000Z");
  } finally {
    fixture.conversations.close();
  }
});

test("real child preparation carries own environment and admitted project/feedback into both role requests", async () => {
  const fixture = createFixture();
  const stores = openBtccSqliteStores({
    dbPath: join(fixture.root, "contexts.sqlite"), ownerId: "shared-context", storageProfile: "ephemeral",
  });
  try {
    writeFileSync(join(fixture.butlerData, "butler.config.json"), JSON.stringify({ user: {
      timezone: "Asia/Seoul", language: "ko", responseLanguage: "Korean",
      techLanguage: "English", location: "Seoul, Korea",
    } }));
    mkdirSync(join(fixture.butlerData, "cognition", "memory", "projects"), { recursive: true });
    writeFileSync(join(fixture.butlerData, "cognition", "memory", "projects", "shared-project.md"), "PROJECT_MEMORY_SHARED");
    mkdirSync(join(fixture.binding.workspacePath, ".butler"), { recursive: true });
    writeFileSync(join(fixture.binding.workspacePath, ".butler", "hot-cache.md"), "PROJECT_HOT_CACHE_SHARED");
    addFeedbackEntry(fixture.butlerData, { scope: "session:parent-session", targetRef: "request", text: "PARENT_CORRECTION_SHARED" });
    addFeedbackEntry(fixture.butlerData, { scope: "session:unrelated", targetRef: "request", text: "UNRELATED_SESSION_PRIVATE" });
    addFeedbackEntry(fixture.butlerData, { scope: "style", targetRef: "answers", text: "USER_STYLE_SHARED" });
    let binding: StoredSessionBinding = {
      ...fixture.binding, sessionId: "parent-session", role: "butler", metadata: {},
      projectId: "shared-project", appProjectId: "shared-project", ledgerProjectId: "ledger-shared-project",
    };
    const turns = new Map<string, TurnRecord>();
    const preparation = new DefaultBtccTurnPreparation({
      bindingStore: { getBySessionId: () => binding }, conversationStore: fixture.conversations,
      butlerData: fixture.butlerData,
      promptAssembler: new PromptAssembler({ butlerHome: fixture.butlerHome, butlerData: fixture.butlerData }),
      contextDocuments: stores.contextDocuments,
      turns: { findTurn: async (id) => turns.get(id) ?? null },
      wakeAuthorizations: { validateWake: async () => false },
    });
    const captured: ModelRoundRequest[] = [];
    const agent = createProductionGuidedTurnAgent({
      phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
      butlerHome: fixture.butlerHome, butlerData: fixture.butlerData,
      contextDocuments: stores.contextDocuments, toolJournal: stores.guidedToolJournal,
      effectJournal: stores.guidedEffectJournal, durableWork: stores.durableWork,
      modelRound: { async runRound(request) { captured.push(request); return { text: "done", toolCalls: [] }; } },
    });
    let parentTurn: TurnRecord | undefined;
    for (const [index, role] of (["butler", "steward", "worker"] as const).entries()) {
      if (parentTurn) {
        const inherited = await snapshotChildProjectContext({
          parentSessionId: binding.sessionId, parentTurnId: parentTurn.turnId, parent: binding,
          turns: { findTurn: async (id) => turns.get(id) ?? null }, documents: stores.contextDocuments,
        });
        binding = { ...fixture.binding, ...inherited.inheritedProject?.sessionBinding,
          role, sessionId: `${role}-session`, metadata: { subsession: {
            ...fixture.binding.metadata?.subsession as object,
            project_context: inherited.inheritedProject?.metadata,
            recent_feedback_refs: inherited.recentFeedbackRefs,
          } },
        };
      }
      const request = requestFor(binding, `turn-shared-${role}`);
      request.message.timestamp = `2026-09-03T0${index}:02:03.000Z`;
      const prepared = await preparation.prepare(request);
      if (prepared.command.kind !== "run") throw new Error("fresh command required");
      const turn = turnFrom(prepared.command);
      turns.set(turn.turnId, turn);
      await agent.run({ turn, signal: new AbortController().signal });
      const providerRequest = captured.at(-1)!;
      const text = JSON.stringify(providerRequest);
      for (const expected of ["RUNTIME_CONTRACT_SHARED", "DATA_EOL_V1", "SHARED_USER_RULE",
        "Asia/Seoul", "User Language: ko", "Assistant Response Language: Korean",
        "User Technical Language: English", "Seoul, Korea", "Current Local Time:",
        request.message.timestamp, "PROJECT_MEMORY_SHARED", "PROJECT_HOT_CACHE_SHARED",
        "PARENT_CORRECTION_SHARED", "USER_STYLE_SHARED", request.message.content]) {
        expect(text).toContain(expected!);
      }
      expect(providerRequest.instructions).toContain("Use Korean for every user-facing message");
      expect(text).not.toContain("UNRELATED_SESSION_PRIVATE");
      expect(text.split("PARENT_CORRECTION_SHARED")).toHaveLength(2);
      expect(text.split("USER_STYLE_SHARED")).toHaveLength(2);
      if (role !== "butler") {
        expect(providerRequest.instructions).toContain(role === "steward" ? "You are the Steward role" : "You are Worker");
        expect(text).not.toContain("BUTLER_PERSONA_PRIVATE");
        expect(text).not.toContain("BUTLER_PROFILE_PRIVATE");
        expect(text).not.toContain("First-Chat Onboarding");
        expect(text).not.toContain(parentTurn!.originalMessageId);
      }
      parentTurn = turn;
    }
  } finally {
    stores.close();
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
        buildStewardContextAssembly: (input) => ({
          ...assembler.buildStewardContextAssembly(input),
          liveConfiguration: [{
            ...assembler.buildStewardContextAssembly(input).liveConfiguration[0]!,
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
        buildStewardContextAssembly: (input) => assembler.buildStewardContextAssembly(input),
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
  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT_SHARED", "utf8");
  writeFileSync(join(butlerData, "eol.md"), "DATA_EOL_V1", "utf8");
  writeFileSync(join(butlerData, "config", "steward.md"), "STEWARD_CONFIG_PRIVATE", "utf8");
  writeFileSync(join(butlerData, "personas", "active.md"), "BUTLER_PERSONA_PRIVATE", "utf8");
  writeFileSync(
    join(butlerData, "personalization", "profile.json"),
    JSON.stringify({ butler_nickname: "BUTLER_PROFILE_PRIVATE" }),
    "utf8",
  );
  writeFileSync(join(butlerData, "cognition", "memory", "rules", "INDEX.md"), "[Rule](core.md)", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "rules", "core.md"), "SHARED_USER_RULE", "utf8");
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
      role: binding.role,
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
