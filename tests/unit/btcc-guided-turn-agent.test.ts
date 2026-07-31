import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { digest } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";

test("Guided agent exposes only typed Project Ledger effects in a writable project turn", async () => {
  const fixture = createFixture("guided-policy");
  try {
    const availability = async (turn: TurnRecord, query = "project_ledger_create") => {
      let result: unknown;
      const agent = fixture.agent(async (options) => {
        result = await options.executeTool({
          name: "tool_search",
          args: { query, include_disabled: true },
          rawArguments: JSON.stringify({ query, include_disabled: true }),
        });
        return "확인했습니다.";
      });
      await agent.run({ turn, signal: new AbortController().signal });
      const results = (result as { results?: Array<{ id: string; enabled: boolean }> }).results ?? [];
      return results.find((entry) => entry.id === `native:${query}`)?.enabled;
    };

    let updateDescription: unknown;
    const descriptionAgent = fixture.agent(async (options) => {
      updateDescription = await options.executeTool({
        name: "tool_describe",
        args: { ids: ["native:project_ledger_update"] },
        rawArguments: JSON.stringify({ ids: ["native:project_ledger_update"] }),
      });
      return "확인했습니다.";
    });

    const fullAccessProjectTurn = turnRecord(fixture.root, {
      accessMode: "full_access",
      trackingMode: "ledger",
      projectId: "project-1",
    });
    expect(await availability(fullAccessProjectTurn)).toBe(true);
    await descriptionAgent.run({
      turn: {
        ...fullAccessProjectTurn,
        turnId: "turn-project-description",
        inboxId: "inbox:turn-project-description",
        triggerKey: "trigger:turn-project-description",
        originalMessageId: "message:turn-project-description",
      },
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(updateDescription)).toContain('"required":["kind","id"]');
    expect(await availability(fullAccessProjectTurn, "render_project_dashboard"))
      .toBeUndefined();
    expect(await availability(fullAccessProjectTurn, "complete_project_work"))
      .toBeUndefined();
    expect(await availability(turnRecord(fixture.root, {
      accessMode: "read_only",
      trackingMode: "ledger",
      projectId: "project-1",
      turnId: "turn-read-only",
    }))).toBeUndefined();

    let visibleNames: string[] = [];
    let instructions = "";
    const projectAgent = fixture.agent(async (options) => {
      visibleNames = options.tools.map((tool) => tool.name);
      instructions = options.instructions ?? "";
      return "준비했습니다.";
    });
    await projectAgent.run({
      turn: turnRecord(fixture.root, {
        accessMode: "full_access",
        trackingMode: "ledger",
        projectId: "project-visible",
        turnId: "turn-project-visible",
      }),
      signal: new AbortController().signal,
    });
    expect(visibleNames).toContain("write_file");
    expect(visibleNames).toContain("project_ledger_status");
    expect(visibleNames).not.toContain("project_ledger_create");
    expect(instructions).toContain("use the internal Work record for continuity");
    expect(instructions).toContain("unless a reviewed effect tool is explicitly available");
  } finally {
    fixture.close();
  }
});

test("Guided agent legacy fallback never grants full access without an admitted access mode", async () => {
  const fixture = createFixture("guided-legacy-policy");
  try {
    const turn = turnRecord(fixture.root, { turnId: "legacy-turn" });
    delete turn.context.executionPolicy;
    turn.modelSelection.controls = {};
    let names: string[] = [];
    let prompt = "";
    const agent = fixture.agent(async (options) => {
      names = options.tools.map((tool) => tool.name);
      prompt = options.prompt;
      return "읽기 전용으로 확인했습니다.";
    });
    await agent.run({ turn, signal: new AbortController().signal });
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("write_file");
    expect(prompt).toContain("access: read_only");
  } finally {
    fixture.close();
  }
});

test("Guided agent treats admitted Turn access as the upper permission bound", async () => {
  const fixture = createFixture("guided-access-bound");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "bounded-turn",
      accessMode: "full_access",
    });
    turn.modelSelection.controls = { accessMode: "read_only" };
    turn.context.executionPolicy!.requiredNativeToolProfiles = [
      "automation",
      "memory-write",
      "mcp",
    ];
    turn.context.executionPolicy!.requiredNativeTools = [
      "create_automation",
      "update_explicit_memory",
      "call_mcp_tool",
    ];
    let names: string[] = [];
    const unsafeAvailability: boolean[] = [];
    let deniedMutation: unknown;
    const agent = fixture.agent(async (options) => {
      names = options.tools.map((tool) => tool.name);
      for (const name of [
        "create_automation",
        "update_explicit_memory",
        "call_mcp_tool",
      ]) {
        const result = await options.executeTool({
          name: "tool_search",
          args: { query: name, include_disabled: true },
          rawArguments: JSON.stringify({ query: name, include_disabled: true }),
        }) as { results?: Array<{ name: string; enabled: boolean }> };
        unsafeAvailability.push(
          result.results?.find((entry) => entry.name === name)?.enabled ?? false,
        );
      }
      deniedMutation = await options.executeTool({
        name: "write_file",
        args: { path: "forbidden.txt", content: "no", overwrite: false },
        rawArguments: JSON.stringify({
          path: "forbidden.txt",
          content: "no",
          overwrite: false,
        }),
      });
      return "읽기 권한 범위에서 확인했습니다.";
    });
    await agent.run({ turn, signal: new AbortController().signal });
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("write_file");
    expect(unsafeAvailability).toEqual([false, false, false]);
    expect(deniedMutation).toMatchObject({
      ok: false,
      error: { code: "tool_not_authorized" },
    });
    expect(existsSync(join(fixture.root, "forbidden.txt"))).toBe(false);
  } finally {
    fixture.close();
  }
});

test("direct and tool_call file mutations use the same reviewed effect gate", async () => {
  const fixture = createFixture("guided-effect-bridge");
  try {
    let direct: unknown;
    let bridged: unknown;
    const agent = fixture.agent(async (options) => {
      direct = await options.executeTool({
        name: "write_file",
        args: { path: "direct.txt", content: "blocked", overwrite: false },
        rawArguments: JSON.stringify({
          path: "direct.txt",
          content: "blocked",
          overwrite: false,
        }),
      });
      bridged = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:write_file",
          arguments: {
            path: "bridged.txt",
            content: "blocked",
            overwrite: false,
          },
        },
        rawArguments: JSON.stringify({
          id: "native:write_file",
          arguments: {
            path: "bridged.txt",
            content: "blocked",
            overwrite: false,
          },
        }),
      });
      return "검토된 Plan이 없어 파일을 변경하지 않았습니다.";
    });

    await agent.run({
      turn: turnRecord(fixture.root, { turnId: "turn-effect-bridge" }),
      signal: new AbortController().signal,
    });

    expect(direct).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
    });
    expect(bridged).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
      bridge_invocation: { id: "native:write_file" },
    });
    expect(existsSync(join(fixture.root, "direct.txt"))).toBe(false);
    expect(existsSync(join(fixture.root, "bridged.txt"))).toBe(false);
  } finally {
    fixture.close();
  }
});

test("Guided agent renders CSV text once and passes image attachments to the provider", async () => {
  const fixture = createFixture("guided-attachments");
  try {
    const csvPath = join(fixture.root, "products.csv");
    const imagePath = join(fixture.root, "photo.png");
    writeFileSync(csvPath, "name,pork_percent\nA,91\nB,82\n");
    writeFileSync(imagePath, "not-a-real-image");
    let prompt = "";
    let attachments: unknown[] = [];
    const agent = fixture.agent(async (options) => {
      prompt = options.prompt;
      attachments = options.attachments ?? [];
      return "분석했습니다.";
    });
    const turn = turnRecord(fixture.root, {
      attachments: [{
        id: "csv-1",
        kind: "document",
        mimeType: "text/csv",
        fileName: "products.csv",
        localPath: csvPath,
      }, {
        id: "image-1",
        kind: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        localPath: imagePath,
      }],
    });

    await agent.run({ turn, signal: new AbortController().signal });

    expect(prompt.match(/name,pork_percent/g)?.length).toBe(1);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "guided-image:image-1",
      kind: "image",
      localPath: imagePath,
    });
  } finally {
    fixture.close();
  }
});

test("Guided agent offers only the three optional R3 Work tools and keeps direct turns free of Work", async () => {
  const fixture = createFixture("guided-work-surface");
  try {
    let visibleNames: string[] = [];
    const turn = turnRecord(fixture.root, {
      turnId: "turn-direct-with-work-available",
      trackingMode: "local",
    });
    const agent = fixture.agent(async (options) => {
      visibleNames = options.tools.map((tool) => tool.name);
      return "안녕하세요.";
    });

    const outcome = await agent.run({
      turn,
      signal: new AbortController().signal,
    });

    expect(visibleNames).toContain("replace_work_plan");
    expect(visibleNames).toContain("record_work_checkpoint");
    expect(visibleNames).toContain("record_work_review");
    expect(visibleNames).not.toContain("update_todo_list");
    expect(visibleNames).not.toContain("list_todo_list");
    expect(visibleNames).not.toContain("list_work_streams");
    expect(visibleNames).not.toContain("update_work_stream_state");
    expect(outcome.route).toBe("direct");
    expect(await fixture.stores.durableWork.boundWorkForTurn(turn.turnId)).toBeNull();
  } finally {
    fixture.close();
  }
});

test("Guided tool discovery hides the retired R2 Work catalog", async () => {
  const fixture = createFixture("guided-work-catalog");
  try {
    let searchResult: unknown;
    let describeResult: unknown;
    const agent = fixture.agent(async (options) => {
      searchResult = await options.executeTool({
        name: "tool_search",
        args: { query: "work", include_disabled: true },
        rawArguments: JSON.stringify({ query: "work", include_disabled: true }),
      });
      describeResult = await options.executeTool({
        name: "tool_describe",
        args: { ids: ["native:list_work_streams", "native:control_work"] },
        rawArguments: JSON.stringify({
          ids: ["native:list_work_streams", "native:control_work"],
        }),
      });
      return "현재 작업 도구를 확인했습니다.";
    });

    await agent.run({
      turn: turnRecord(fixture.root, {
        turnId: "turn-work-catalog",
        trackingMode: "local",
      }),
      signal: new AbortController().signal,
    });

    const encodedSearch = JSON.stringify(searchResult);
    expect(encodedSearch).not.toContain("list_work_streams");
    expect(encodedSearch).not.toContain("update_work_stream_state");
    expect(encodedSearch).not.toContain("control_work");
    expect(encodedSearch).not.toContain("project_ledger_work_update");
    expect(encodedSearch).not.toContain("project_ledger_work_complete");
    expect(encodedSearch).not.toContain("complete_project_work");
    expect(describeResult).toMatchObject({
      ok: false,
      descriptions: [],
      missing: [
        { id: "native:list_work_streams", error: "unknown_tool_catalog_id" },
        { id: "native:control_work", error: "unknown_tool_catalog_id" },
      ],
    });
  } finally {
    fixture.close();
  }
});

test("Guided agent replays completed tool results and fences uncertain mutations", async () => {
  const fixture = createFixture("guided-replay");
  try {
    const factPath = join(fixture.root, "fact.txt");
    writeFileSync(factPath, "first value");
    const turn = turnRecord(fixture.root, { turnId: "turn-read-replay" });
    const outputs: unknown[] = [];
    const rawRead = JSON.stringify({ path: "fact.txt" });
    const runRead = async () => {
      const agent = fixture.agent(async (options) => {
        outputs.push(await options.executeTool({
          name: "read_file",
          args: { path: "fact.txt" },
          rawArguments: rawRead,
        }));
        return "읽었습니다.";
      });
      return agent.run({ turn, signal: new AbortController().signal });
    };
    await runRead();
    writeFileSync(factPath, "second value");
    await runRead();
    expect(outputs[1]).toEqual(outputs[0]);
    expect(JSON.stringify(outputs[1])).toContain("first value");
    expect(fixture.stores.guidedToolJournal.list(turn.turnId)).toHaveLength(1);

    const mutationTurn = turnRecord(fixture.root, { turnId: "turn-uncertain-mutation" });
    const mutationArgs = {
      path: "out.txt",
      content: "durable output",
      overwrite: false,
    };
    const rawMutation = JSON.stringify(mutationArgs);
    const callId = digest([
      "btcc-guided-tool-call.v1",
      mutationTurn.turnId,
      "0",
      "write_file",
      rawMutation,
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: mutationTurn.turnId,
      callId,
      toolName: "write_file",
      rawArguments: rawMutation,
      arguments: mutationArgs,
    });
    let uncertain: unknown;
    const mutationAgent = fixture.agent(async (options) => {
      uncertain = await options.executeTool({
        name: "write_file",
        args: mutationArgs,
        rawArguments: rawMutation,
      });
      return "상태를 먼저 확인해야 합니다.";
    });
    const outcome = await mutationAgent.run({
      turn: mutationTurn,
      signal: new AbortController().signal,
    });
    expect(uncertain).toMatchObject({
      ok: false,
      error: { code: "effect_work_required" },
    });
    expect(existsSync(join(fixture.root, "out.txt"))).toBe(false);
    expect(outcome.route).toBe("assisted");
  } finally {
    fixture.close();
  }
});

test("Guided agent rejects provider failure instead of completing with pre-tool text and treats read-only commands as assisted", async () => {
  const fixture = createFixture("guided-fallback");
  try {
    const fallbackAgent = fixture.agent(async (options) => {
      await options.onAssistantTextBeforeTools?.({
        text: "확인한 범위에서는 설정 파일이 존재합니다.",
        toolCalls: [{ name: "read_file", args: { path: "settings.json" } }],
      });
      throw new Error("provider disconnected after usable text");
    });
    await expect(fallbackAgent.run({
      turn: turnRecord(fixture.root),
      signal: new AbortController().signal,
    })).rejects.toThrow("provider disconnected after usable text");

    const commandAgent = fixture.agent(async (options) => {
      await options.executeTool({
        name: "run_command",
        args: { command: "pwd", state_effect: "read_only" },
        rawArguments: JSON.stringify({ command: "pwd", state_effect: "read_only" }),
      });
      return "폴더를 확인했습니다.";
    });
    expect((await commandAgent.run({
      turn: turnRecord(fixture.root, { turnId: "turn-command" }),
      signal: new AbortController().signal,
    })).route).toBe("assisted");
  } finally {
    fixture.close();
  }
});

function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  const dbPath = join(root, "butler.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: label,
    storageProfile: "ephemeral",
  });
  return {
    root,
    stores,
    agent(promptRunner: Parameters<typeof createProductionGuidedTurnAgent>[0]["promptRunner"]) {
      return createProductionGuidedTurnAgent({
        butlerHome: root,
        butlerData: root,
        appMessageDbPath: dbPath,
        contextDocuments: stores.contextDocuments,
        toolJournal: stores.guidedToolJournal,
        effectJournal: stores.guidedEffectJournal,
        durableWork: stores.durableWork,
        promptRunner,
      });
    },
    close() {
      stores.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function turnRecord(
  workspacePath: string,
  options: {
    turnId?: string;
    accessMode?: "full_access" | "ask_first" | "read_only";
    trackingMode?: "ledger" | "local" | "none";
    projectId?: string;
    attachments?: NonNullable<TurnRecord["context"]["attachments"]>;
  } = {},
): TurnRecord {
  const turnId = options.turnId ?? "guided-agent-turn";
  return {
    turnId,
    sessionId: "guided-agent-session",
    inboxId: `inbox:${turnId}`,
    triggerKey: `trigger:${turnId}`,
    originalMessageId: `message:${turnId}`,
    originalMessage: "요청을 처리해 주세요",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: options.accessMode ?? "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      ...(options.projectId ? { projectRef: options.projectId } : {}),
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: options.accessMode ?? "full_access",
        trackingMode: options.trackingMode ?? "none",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      },
      ...(options.attachments ? { attachments: options.attachments } : {}),
    },
    continuationCandidates: [],
    semanticState: "admitted",
    checkpoint: {
      checkpointId: `checkpoint:${turnId}`,
      checkpointRevision: 1,
      kind: "runtime",
      semanticState: "admitted",
    },
    revision: 0,
    executionFence: 0,
  };
}
