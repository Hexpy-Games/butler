import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import type { DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/durable-work/index.ts";
import { createGuidedTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/guided-turn/index.ts";
import {
  digest,
  stableJson,
} from "../../packages/butler-agent/src/agent/btcc/identity/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";
import {
  DEFAULT_GUIDED_FINAL_REPORT_MS,
  DEFAULT_GUIDED_TURN_LEASE_MS,
  guidedOperationalFallback,
  guidedOperationalReportPrompt,
  runGuidedPromptWithOperationalReport,
} from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-operational-report.ts";
import { createGuidedToolCallExecutor } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-tool-call-execution.ts";
import { authorizedToolDefinitions, isReplaySafeTool } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-turn-policy.ts";
import { upsertMcpServer } from
  "../../packages/butler-agent/src/interfaces/mcp-client/registry.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

test("Guided agent leaves web query planning to the selected model", async () => {
  const fixture = createFixture("guided-model-owned-search");
  try {
    writeFileSync(join(fixture.root, "butler.config.json"), JSON.stringify({
      webSearch: { provider: "mock" },
    }));
    let searchResult: Record<string, any> | undefined;
    const agent = fixture.agent(async (options) => {
      searchResult = await options.executeTool({
        name: "web_search",
        args: { query: "Butler guided search ownership" },
        rawArguments: JSON.stringify({
          query: "Butler guided search ownership",
        }),
      }) as Record<string, any>;
      return "검색했습니다.";
    });

    await agent.run({
      turn: turnRecord(fixture.root, { turnId: "guided-model-owned-search" }),
      signal: new AbortController().signal,
    });

    expect(searchResult?.search_plan).toMatchObject({
      mode: "direct",
      planner_used: false,
      planner_attempts: 0,
      original_query: "Butler guided search ownership",
    });
    expect(searchResult?.search_plan?.fallback_reason).toBe(
      "guided model owns search planning",
    );
  } finally {
    fixture.close();
  }
});

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
    let writeFileSchema = "";
    let editFileSchema = "";
    let instructions = "";
    let maxToolRounds = 0;
    const projectAgent = fixture.agent(async (options) => {
      visibleNames = options.tools.map((tool) => tool.name);
      writeFileSchema = JSON.stringify(
        options.tools.find((tool) => tool.name === "write_file")?.parameters,
      );
      editFileSchema = JSON.stringify(
        options.tools.find((tool) => tool.name === "edit_file")?.parameters,
      );
      instructions = options.instructions ?? "";
      maxToolRounds = options.maxToolRounds ?? 0;
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
    expect(visibleNames).toContain("edit_file");
    expect(writeFileSchema).not.toContain("expected_sha256");
    expect(writeFileSchema).not.toContain("overwrite");
    expect(writeFileSchema).toContain("create_parents");
    expect(editFileSchema).not.toContain("expected_sha256");
    expect(visibleNames).toContain("project_ledger_status");
    expect(visibleNames).toContain("project_ledger_list");
    expect(visibleNames).not.toContain("project_ledger_show");
    expect(visibleNames).toContain("project_ledger_create");
    expect(visibleNames).not.toContain("project_ledger_work_update");
    expect(visibleNames).toContain("project_ledger_work_complete");
    expect(instructions).toContain("keep one concise Project Ledger Work record");
    expect(instructions).toContain("Check for related Work first and reuse it");
    expect(instructions).toContain(
      "complete it after validating the requested outcome",
    );
    expect(instructions).not.toContain(
      "Do not attempt to mutate the Project Ledger",
    );
    expect(maxToolRounds).toBe(Number.POSITIVE_INFINITY);

    let localVisibleNames: string[] = [];
    let localSearch: unknown;
    let localDescription: unknown;
    let localCatalogCall: unknown;
    let localDirectCall: unknown;
    const localAgent = fixture.agent(async (options) => {
      localVisibleNames = options.tools.map((tool) => tool.name);
      localSearch = await options.executeTool({
        name: "tool_search",
        args: { query: "project_ledger_create", include_disabled: true },
        rawArguments: JSON.stringify({
          query: "project_ledger_create",
          include_disabled: true,
        }),
      });
      localDescription = await options.executeTool({
        name: "tool_describe",
        args: { ids: ["native:project_ledger_create"] },
        rawArguments: JSON.stringify({ ids: ["native:project_ledger_create"] }),
      });
      localCatalogCall = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:project_ledger_create",
          arguments: {
            kind: "work",
            id: "W-MUST-NOT-EXIST",
            title: "Must not exist",
            acceptance: "Must remain unavailable",
          },
        },
        rawArguments: JSON.stringify({
          id: "native:project_ledger_create",
          arguments: {
            kind: "work",
            id: "W-MUST-NOT-EXIST",
            title: "Must not exist",
            acceptance: "Must remain unavailable",
          },
        }),
      });
      localDirectCall = await options.executeTool({
        name: "project_ledger_create",
        args: {
          kind: "work",
          id: "W-MUST-NOT-EXIST",
          title: "Must not exist",
          acceptance: "Must remain unavailable",
        },
        rawArguments: JSON.stringify({
          kind: "work",
          id: "W-MUST-NOT-EXIST",
          title: "Must not exist",
          acceptance: "Must remain unavailable",
        }),
      });
      return "세션 작업으로 처리했습니다.";
    });
    await localAgent.run({
      turn: turnRecord(fixture.root, {
        accessMode: "full_access",
        trackingMode: "local",
        projectId: "project-local",
        turnId: "turn-project-local-work",
      }),
      signal: new AbortController().signal,
    });
    expect(localVisibleNames).not.toContain("project_ledger_create");
    expect(localVisibleNames).not.toContain("project_ledger_work_complete");
    expect((localSearch as { results?: Array<{ id: string }> }).results ?? [])
      .not.toContainEqual(expect.objectContaining({
        id: "native:project_ledger_create",
      }));
    expect(localDescription).toMatchObject({
      ok: false,
      descriptions: [],
      missing: [{
        id: "native:project_ledger_create",
        error: "unknown_tool_catalog_id",
      }],
    });
    expect(localCatalogCall).toMatchObject({ ok: false });
    expect(localDirectCall).toMatchObject({
      ok: false,
      error: { code: "tool_not_authorized" },
    });
  } finally {
    fixture.close();
  }
});

test("Guided project Work initializes and closes Project Ledger through reviewed effects", async () => {
  const fixture = createFixture("guided-project-ledger-lifecycle");
  const ledgerRoot = join(
    fixture.root,
    "project-ledger",
    "projects",
    "guided-ledger-project",
  );
  writeFileSync(
    join(fixture.root, "package.json"),
    `${JSON.stringify({ name: "guided-ledger-project" })}\n`,
  );
  bindAppProject(fixture.dbPath, {
    id: "guided-project-session",
    workspacePath: fixture.root,
    ledgerProjectId: "guided-ledger-project",
  });
  try {
    const results: unknown[] = [];
    const agent = fixture.agent(async (options) => {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await options.executeTool({
          name,
          args,
          rawArguments: JSON.stringify(args),
        });
        results.push(result);
        return result;
      };
      await call("replace_work_plan", {
        objective: "Complete one tracked project change",
        actions: [{
          action_key: "create-ledger-work",
          description: "Create one concise Project Ledger Work record",
          effect: {
            capability: "project_ledger_create",
            target: "project-ledger:work:W-GUIDED-LIFECYCLE",
          },
        }, {
          action_key: "complete-ledger-work",
          description: "Complete the Project Ledger Work after validation",
          dependency_keys: ["create-ledger-work"],
          effect: {
            capability: "project_ledger_work_complete",
            target: "project-ledger:work:W-GUIDED-LIFECYCLE",
          },
        }],
        checks: ["The canonical Project Ledger Work is done"],
      });
      await call("record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The plan is concise and matches the project request.",
      });
      expect(existsSync(ledgerRoot)).toBe(false);
      await call("project_ledger_create", {
        kind: "work",
        id: "W-GUIDED-LIFECYCLE",
        title: "Guided project lifecycle",
        status: "proposed",
        spec: "SPEC-GUIDED-LIFECYCLE",
        acceptance: "The tracked project result is validated and reported",
      });
      await call("project_ledger_work_complete", {
        id: "W-GUIDED-LIFECYCLE",
        validation: "Lifecycle integration test passed",
        review: "The requested tracked outcome is complete",
        report: "The Guided result contains the completed outcome",
      });
      await call("record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The Project Ledger Work was created and completed.",
      });
      return "프로젝트 작업과 기록을 완료했습니다.";
    }, { butlerHome: process.cwd() });
    const turnId = "turn-guided-project-ledger-lifecycle";
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    expect(await runtime.runTurn(projectRunCommand(fixture.root, turnId)))
      .toMatchObject({
      kind: "delivered",
      content: "프로젝트 작업과 기록을 완료했습니다.",
    });
    for (const result of results) {
      expect(result).toMatchObject({ ok: true });
    }
    expect(existsSync(join(ledgerRoot, "project.json"))).toBe(true);
    expect(existsSync(join(ledgerRoot, "work", "W-GUIDED-LIFECYCLE", "work.md")))
      .toBe(true);
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(work).toMatchObject({
      status: "completed",
      latestResultReview: { verdict: "accept" },
    });
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toHaveLength(2);
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    fixture.close();
  }
});

test("Guided Project Ledger mutation fails closed for missing or archived App rows", async () => {
  for (const archived of [false, true]) {
    const fixture = createFixture(
      archived ? "guided-archived-project-binding" : "guided-missing-project-binding",
    );
    const ledgerId = archived
      ? "archived-ledger-must-not-exist"
      : "missing-ledger-must-not-exist";
    writeFileSync(
      join(fixture.root, "package.json"),
      `${JSON.stringify({ name: ledgerId })}\n`,
    );
    prepareAppProjectsTable(fixture.dbPath);
    if (archived) {
      bindAppProject(fixture.dbPath, {
        id: "guided-project-session",
        workspacePath: fixture.root,
        ledgerProjectId: ledgerId,
        archived: true,
      });
    }
    try {
      let mutationResult: unknown;
      const agent = fixture.agent(async (options) => {
        await options.executeTool({
          name: "replace_work_plan",
          args: {
            objective: "Verify the persistent mutation boundary",
            actions: [{
              action_key: "create-ledger-work",
              description: "Create one Project Ledger Work",
              effect: {
                capability: "project_ledger_create",
                target: "project-ledger:work:W-BINDING-FAIL-CLOSED",
              },
            }],
            checks: ["No mutation occurs without the exact App project row"],
          },
          rawArguments: "{}",
        });
        await options.executeTool({
          name: "record_work_review",
          args: {
            subject: "plan",
            verdict: "accept",
            summary: "The boundary check is safe and scoped.",
          },
          rawArguments: "{}",
        });
        mutationResult = await options.executeTool({
          name: "project_ledger_create",
          args: {
            kind: "work",
            id: "W-BINDING-FAIL-CLOSED",
            title: "Must not be created",
            acceptance: "The exact App row is required",
          },
          rawArguments: "{}",
        });
        return "바인딩이 없어 변경하지 않았습니다.";
      }, { butlerHome: process.cwd() });
      const runtime = createGuidedTurnRuntime({
        admission: fixture.stores.admission,
        turns: fixture.stores.turns,
        messages: fixture.stores.messages,
        committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
        agent,
      });
      const turnId = archived
        ? "turn-archived-project-binding"
        : "turn-missing-project-binding";
      await runtime.runTurn(projectRunCommand(fixture.root, turnId));

      expect(mutationResult).toMatchObject({
        ok: false,
        error: {
          code: "effect_reconciliation_required",
          message: expect.stringContaining("exact active App project binding"),
        },
      });
      expect(existsSync(join(
        fixture.root,
        "project-ledger",
        "projects",
        ledgerId,
      ))).toBe(false);
    } finally {
      fixture.close();
    }
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
    expect(names).not.toContain("edit_file");
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

test("Guided discovery exposes registry read tools without enabling unsupported effects", async () => {
  const fixture = createFixture("guided-unsupported-effects");
  try {
    upsertMcpServer(fixture.root, {
      id: "fixture",
      display_name: "Fixture MCP",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: ["--eval", fixtureMcpServerEval()],
      cwd: process.cwd(),
    });
    const turn = turnRecord(fixture.root, {
      turnId: "guided-unsupported-effects-turn",
      accessMode: "full_access",
      trackingMode: "local",
    });
    const authorizedNames = authorizedToolDefinitions(turn)
      .map((tool) => tool.name);
    expect(authorizedNames).toContain("list_automations");
    expect(authorizedNames).toContain("list_mcp_capabilities");
    expect(authorizedNames).toContain("read_mcp_resource");
    expect(authorizedNames).toContain("query_memory");
    expect(authorizedNames).toContain("get_usage_monitor");
    expect(authorizedNames).not.toContain("create_automation");
    expect(authorizedNames).not.toContain("call_mcp_tool");
    expect(authorizedNames).not.toContain("transform_public_data_table");

    let initialNames: string[] = [];
    let automationSearch: unknown;
    let mcpSearch: unknown;
    let descriptions: unknown;
    let automationList: unknown;
    let capabilityList: unknown;
    let mcpCapabilities: unknown;
    let mcpResource: unknown;
    let memoryQuery: unknown;
    let usageMonitor: unknown;
    let mcpCall: unknown;
    const agent = fixture.agent(async (options) => {
      initialNames = options.tools.map((tool) => tool.name);
      automationSearch = await options.executeTool({
        name: "tool_search",
        args: {
          provider: "native",
          category: "automation",
          include_disabled: true,
        },
        rawArguments: JSON.stringify({
          provider: "native",
          category: "automation",
          include_disabled: true,
        }),
      });
      mcpSearch = await options.executeTool({
        name: "tool_search",
        args: {
          provider: "mcp",
          category: "mcp",
          capability: "issue",
          include_disabled: true,
        },
        rawArguments: JSON.stringify({
          provider: "mcp",
          category: "mcp",
          capability: "issue",
          include_disabled: true,
        }),
      });
      descriptions = await options.executeTool({
        name: "tool_describe",
        args: {
          ids: [
            "native:create_automation",
            "native:list_automations",
            "native:list_tool_capabilities",
            "native:call_mcp_tool",
            "native:list_mcp_capabilities",
            "native:read_mcp_resource",
            "native:query_memory",
            "native:get_usage_monitor",
            "mcp:fixture:find_issue",
          ],
        },
        rawArguments: JSON.stringify({
          ids: [
            "native:create_automation",
            "native:list_automations",
            "native:list_tool_capabilities",
            "native:call_mcp_tool",
            "native:list_mcp_capabilities",
            "native:read_mcp_resource",
            "native:query_memory",
            "native:get_usage_monitor",
            "mcp:fixture:find_issue",
          ],
        }),
      });
      automationList = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:list_automations",
          arguments: {},
        },
        rawArguments: JSON.stringify({
          id: "native:list_automations",
          arguments: {},
        }),
      });
      capabilityList = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:list_tool_capabilities",
          arguments: { include_disabled: true },
        },
        rawArguments: JSON.stringify({
          id: "native:list_tool_capabilities",
          arguments: { include_disabled: true },
        }),
      });
      mcpCapabilities = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:list_mcp_capabilities",
          arguments: {},
        },
        rawArguments: JSON.stringify({
          id: "native:list_mcp_capabilities",
          arguments: {},
        }),
      });
      mcpResource = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:read_mcp_resource",
          arguments: {
            server_id: "fixture",
            uri: "butler://fixture",
          },
        },
        rawArguments: JSON.stringify({
          id: "native:read_mcp_resource",
          arguments: {
            server_id: "fixture",
            uri: "butler://fixture",
          },
        }),
      });
      memoryQuery = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:query_memory",
          arguments: { scope: "session" },
        },
        rawArguments: JSON.stringify({
          id: "native:query_memory",
          arguments: { scope: "session" },
        }),
      });
      usageMonitor = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:get_usage_monitor",
          arguments: {},
        },
        rawArguments: JSON.stringify({
          id: "native:get_usage_monitor",
          arguments: {},
        }),
      });
      mcpCall = await options.executeTool({
        name: "tool_call",
        args: {
          id: "mcp:fixture:find_issue",
          arguments: { query: "BTCC" },
        },
        rawArguments: JSON.stringify({
          id: "mcp:fixture:find_issue",
          arguments: { query: "BTCC" },
        }),
      });
      return "현재 R3에서 실행 가능한 도구 범위를 확인했습니다.";
    });

    await agent.run({
      turn,
      signal: new AbortController().signal,
    });

    for (const name of [
      "list_automations",
      "list_mcp_capabilities",
      "read_mcp_resource",
      "query_memory",
      "get_usage_monitor",
    ]) {
      expect(initialNames).not.toContain(name);
    }

    const automationResults = (
      automationSearch as {
        results: Array<{
          name: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }
    ).results;
    expect(automationResults.find((item) => item.name === "list_automations"))
      .toEqual(expect.objectContaining({
        enabled: true,
        disabled_reason: null,
      }));
    for (const name of [
      "create_automation",
      "delete_automation",
      "run_due_automations",
    ]) {
      expect(automationResults.find((item) => item.name === name))
        .toEqual(expect.objectContaining({
          enabled: false,
          disabled_reason: expect.stringContaining(
            "does not yet have a typed automation effect adapter",
          ),
        }));
    }

    expect(
      (mcpSearch as {
        results: Array<{
          id: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }).results,
    ).toContainEqual(expect.objectContaining({
      id: "mcp:fixture:find_issue",
      enabled: false,
      disabled_reason: expect.stringContaining(
        "does not yet have a guarded MCP effect adapter",
      ),
    }));

    const byId = new Map(
      (descriptions as {
        descriptions: Array<{
          id: string;
          enabled: boolean;
          disabled_reason: string | null;
        }>;
      }).descriptions.map((item) => [item.id, item]),
    );
    expect(byId.get("native:list_automations")?.enabled).toBe(true);
    expect(byId.get("native:list_mcp_capabilities")?.enabled).toBe(true);
    expect(byId.get("native:read_mcp_resource")?.enabled).toBe(true);
    expect(byId.get("native:query_memory")?.enabled).toBe(true);
    expect(byId.get("native:get_usage_monitor")?.enabled).toBe(true);
    expect(byId.get("native:create_automation")).toEqual(
      expect.objectContaining({
        enabled: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a typed automation effect adapter",
        ),
      }),
    );
    expect(byId.get("native:call_mcp_tool")).toEqual(expect.objectContaining({
      enabled: false,
      disabled_reason: expect.stringContaining(
        "does not yet have a guarded MCP effect adapter",
      ),
    }));
    expect(byId.get("mcp:fixture:find_issue")).toEqual(expect.objectContaining({
      enabled: false,
      disabled_reason: expect.stringContaining(
        "does not yet have a guarded MCP effect adapter",
      ),
    }));
    expect(automationList).toMatchObject({
      ok: true,
      automations: [],
    });
    const capabilityByName = new Map(
      (capabilityList as {
        capabilities: Array<{
          name: string;
          enabled: boolean;
          current_turn_callable: boolean;
          disabled_reason: string | null;
        }>;
      }).capabilities.map((item) => [item.name, item]),
    );
    expect(capabilityByName.get("list_automations")).toEqual(
      expect.objectContaining({
        enabled: true,
        current_turn_callable: true,
      }),
    );
    expect(capabilityByName.get("create_automation")).toEqual(
      expect.objectContaining({
        enabled: false,
        current_turn_callable: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a typed automation effect adapter",
        ),
      }),
    );
    expect(capabilityByName.get("call_mcp_tool")).toEqual(
      expect.objectContaining({
        enabled: false,
        current_turn_callable: false,
        disabled_reason: expect.stringContaining(
          "does not yet have a guarded MCP effect adapter",
        ),
      }),
    );
    expect(mcpCapabilities).toMatchObject({
      ok: true,
      servers: [
        {
          id: "fixture",
          ok: true,
        },
      ],
    });
    expect(mcpResource).toMatchObject({
      ok: true,
      server_id: "fixture",
      uri: "butler://fixture",
    });
    expect(JSON.stringify(mcpResource)).toContain("fixture");
    expect(memoryQuery).toMatchObject({ ok: true });
    expect(usageMonitor).toMatchObject({ ok: true });
    expect(mcpCall).toMatchObject({
      ok: false,
      error: {
        code: "disabled_tool",
        message: expect.stringContaining(
          "does not yet have a guarded MCP effect adapter",
        ),
      },
    });
  } finally {
    fixture.close();
  }
});

test("Guided replay keeps native read-only MCP and automation tools retryable", () => {
  for (const name of [
    "list_automations",
    "list_mcp_capabilities",
    "read_mcp_resource",
    "list_tool_capabilities",
  ]) {
    expect(isReplaySafeTool(name)).toBe(true);
  }
  expect(isReplaySafeTool("create_automation")).toBe(false);
  expect(isReplaySafeTool("call_mcp_tool")).toBe(false);
  expect(isReplaySafeTool("transform_public_data_table")).toBe(false);
});

test("direct and tool_call file mutations use the same reviewed effect gate", async () => {
  const fixture = createFixture("guided-effect-bridge");
  try {
    let direct: unknown;
    let bridged: unknown;
    const agent = fixture.agent(async (options) => {
      direct = await options.executeTool({
        name: "write_file",
        args: { path: "direct.txt", content: "blocked" },
        rawArguments: JSON.stringify({
          path: "direct.txt",
          content: "blocked",
        }),
      });
      bridged = await options.executeTool({
        name: "tool_call",
        args: {
          id: "native:write_file",
          arguments: {
            path: "bridged.txt",
            content: "blocked",
          },
        },
        rawArguments: JSON.stringify({
          id: "native:write_file",
          arguments: {
            path: "bridged.txt",
            content: "blocked",
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

test("Guided catalog and tool_call execute the same simple write_file contract", async () => {
  const fixture = createFixture("guided-write-file-bridge");
  try {
    let description: unknown;
    let writeResult: unknown;
    const agent = fixture.agent(async (options) => {
      const call = async (name: string, args: Record<string, unknown>) =>
        await options.executeTool({
          name,
          args,
          rawArguments: JSON.stringify(args),
        });
      await call("replace_work_plan", {
        objective: "Create bridged.txt",
        actions: [{
          action_key: "write-bridged-file",
          description: "Write the requested file",
          effect: {
            capability: "write_file",
            target: "workspace:bridged.txt",
          },
        }],
        checks: ["bridged.txt contains the requested content"],
      });
      await call("record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The plan directly creates the requested file.",
      });
      description = await call("tool_describe", {
        ids: ["native:write_file"],
      });
      writeResult = await call("tool_call", {
        id: "native:write_file",
        arguments: {
          path: "bridged.txt",
          content: "bridge contract works\n",
        },
      });
      await call("record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The requested file was written with the exact content.",
      });
      return "브리지 경로로 파일을 작성했습니다.";
    });

    const turnId = "turn-guided-write-file-bridge";
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    expect(await runtime.runTurn(localRunCommand(fixture.root, turnId)))
      .toMatchObject({
        kind: "delivered",
        content: "브리지 경로로 파일을 작성했습니다.",
      });

    const encodedDescription = JSON.stringify(description);
    expect(encodedDescription).not.toContain("expected_sha256");
    expect(encodedDescription).not.toContain("overwrite");
    expect(description).toMatchObject({
      ok: true,
      descriptions: [{
        id: "native:write_file",
        enabled: true,
        schema: { required: ["path", "content"] },
      }],
    });
    expect(writeResult).toMatchObject({
      ok: true,
      effect_receipt: {
        capability: "write_file",
        target: "workspace:bridged.txt",
      },
      bridge_invocation: { id: "native:write_file" },
    });
    expect(readFileSync(join(fixture.root, "bridged.txt"), "utf8"))
      .toBe("bridge contract works\n");
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
  } finally {
    fixture.close();
  }
});

test("Guided agent applies a small edit through the reviewed durable effect", async () => {
  const fixture = createFixture("guided-edit-file");
  try {
    writeFileSync(
      join(fixture.root, "styles.css"),
      "body {\n  overflow-x: auto;\n}\n",
    );
    const results: unknown[] = [];
    let editResult: unknown;
    const agent = fixture.agent(async (options) => {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await options.executeTool({
          name,
          args,
          rawArguments: JSON.stringify(args),
        });
        results.push(result);
        return result;
      };
      await call("replace_work_plan", {
        objective: "Correct the visible horizontal overflow",
        actions: [{
          action_key: "correct-style",
          description: "Make the requested contained workspace correction",
          effect: {
            capability: "workspace mutation",
            target: "workspace:requested-source-change",
          },
        }],
        checks: ["The resulting stylesheet contains the requested correction"],
      });
      await call("record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The small contained correction matches the request.",
      });
      editResult = await call("edit_file", {
        path: "styles.css",
        start_line: 2,
        old_text: "  overflow-x: auto;\n",
        new_text: "  overflow-x: hidden;\n",
        expected_sha256: "0".repeat(64),
      });
      await call("record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The requested stylesheet correction is present.",
      });
      return "가로 넘침 수정을 완료했습니다.";
    });
    const turnId = "turn-guided-edit-file";
    const runtime = createGuidedTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
      agent,
    });
    expect(await runtime.runTurn(localRunCommand(fixture.root, turnId)))
      .toMatchObject({
      kind: "delivered",
      content: "가로 넘침 수정을 완료했습니다.",
    });
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(editResult).toMatchObject({
      ok: true,
      effect_receipt: {
        capability: "edit_file",
        target: "workspace:styles.css",
      },
    });
    expect(readFileSync(join(fixture.root, "styles.css"), "utf8"))
      .toBe("body {\n  overflow-x: hidden;\n}\n");
    const work = await fixture.stores.durableWork.boundWorkForTurn(turnId);
    expect(work?.status).toBe("completed");
    expect(fixture.stores.guidedEffectJournal.listForWork(work!.workId))
      .toEqual([
        expect.objectContaining({
          capability: "edit_file",
          sanitizedTarget: "workspace:styles.css",
          status: "applied",
        }),
      ]);
    expect((await fixture.stores.turns.findTurn(turnId))?.route).toBe("managed");
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
      stableJson(mutationArgs),
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

test("Guided tool restart reuses a prestarted occurrence after call order changes", async () => {
  const fixture = createFixture("guided-restart-call-order");
  try {
    const turn = turnRecord(fixture.root, {
      turnId: "turn-restart-call-order",
    });
    const writeArgs = {
      path: "out.txt",
      content: "durable output",
      overwrite: false,
    };
    const rawWrite = JSON.stringify(writeArgs);
    const prestartedCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "0",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    fixture.stores.guidedToolJournal.start({
      turnId: turn.turnId,
      callId: prestartedCallId,
      toolName: "write_file",
      rawArguments: rawWrite,
      arguments: writeArgs,
    });

    const occurrences: Array<{ toolName: string; occurrenceId?: string }> = [];
    const toolCalls = createGuidedToolCallExecutor({
      turn,
      signal: new AbortController().signal,
      workScope: {
        turnId: turn.turnId,
        sessionId: turn.sessionId,
      },
      authorizedNames: new Set(["grep_files", "write_file"]),
      visibleNames: new Set(["grep_files", "write_file"]),
      describedToolIds: new Set(),
      durableWork: fixture.stores.durableWork,
      toolJournal: fixture.stores.guidedToolJournal,
      executeButlerTool: async (call, context) => {
        occurrences.push({
          toolName: call.name,
          occurrenceId: context?.effectOccurrenceId,
        });
        return { ok: true, tool: call.name };
      },
    });

    await toolCalls.executeTool({
      name: "grep_files",
      args: { query: "fact", path: "." },
      rawArguments: JSON.stringify({ query: "fact", path: "." }),
    });
    await toolCalls.executeTool({
      name: "write_file",
      args: {
        overwrite: false,
        content: "durable output",
        path: "out.txt",
      },
      rawArguments:
        '{ "overwrite": false, "content": "durable output", "path": "out.txt" }',
    });
    await toolCalls.executeTool({
      name: "write_file",
      args: writeArgs,
      rawArguments: rawWrite,
    });

    const reorderedCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "1",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    const newOccurrenceCallId = digest([
      "btcc-guided-tool-call.v1",
      turn.turnId,
      "2",
      "write_file",
      stableJson(writeArgs),
    ].join("\0"));
    expect(occurrences[1]).toEqual({
      toolName: "write_file",
      occurrenceId: prestartedCallId,
    });
    expect(occurrences[2]).toEqual({
      toolName: "write_file",
      occurrenceId: newOccurrenceCallId,
    });
    expect(fixture.stores.guidedToolJournal.find(prestartedCallId)?.status)
      .toBe("completed");
    expect(fixture.stores.guidedToolJournal.find(reorderedCallId)).toBeNull();
    expect(fixture.stores.guidedToolJournal.find(newOccurrenceCallId)?.status)
      .toBe("completed");
  } finally {
    fixture.close();
  }
});

test("Guided agent turns provider failure into one fact-based final report", async () => {
  const fixture = createFixture("guided-fallback");
  try {
    writeFileSync(join(fixture.root, "settings.json"), '{"enabled":true}\n');
    let calls = 0;
    const fallbackAgent = fixture.agent(async (options) => {
      calls += 1;
      if (calls === 2) {
        expect(options.tools).toEqual([]);
        expect(options.prompt).toContain("Tool read_file: completed");
        expect(options.prompt).toContain('enabled\\":true');
        return "설정 파일이 존재하며 enabled 값은 true입니다. 추가 작업은 없습니다.";
      }
      await options.onAssistantTextBeforeTools?.({
        text: "설정 파일을 확인하겠습니다.",
        toolCalls: [{ name: "read_file", args: { path: "settings.json" } }],
      });
      await options.executeTool({
        name: "read_file",
        args: { path: "settings.json" },
        rawArguments: JSON.stringify({ path: "settings.json" }),
        signal: options.signal,
      });
      throw knownProviderFailure("provider disconnected after usable text");
    });
    expect(await fallbackAgent.run({
      turn: turnRecord(fixture.root),
      signal: new AbortController().signal,
    })).toEqual({
      route: "assisted",
      content: "설정 파일이 존재하며 enabled 값은 true입니다. 추가 작업은 없습니다.",
    });
    expect(calls).toBe(2);

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

test("Guided agent gives a normally progressing Turn one operational lease", async () => {
  const fixture = createFixture("guided-caller-boundary");
  try {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const agent = fixture.agent(async (options) => {
      observedSignal = options.signal;
      return "요청을 정상적으로 마쳤습니다.";
    });

    const outcome = await agent.run({
      turn: turnRecord(fixture.root, { turnId: "guided-caller-boundary-turn" }),
      signal: controller.signal,
    });

    expect(observedSignal).not.toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(false);
    expect(outcome).toEqual({
      route: "direct",
      content: "요청을 정상적으로 마쳤습니다.",
    });
  } finally {
    fixture.close();
  }
});

test("Guided model sees remaining time without persisting it in the tool result", async () => {
  const fixture = createFixture("guided-turn-time-context");
  try {
    writeFileSync(join(fixture.root, "settings.json"), '{"enabled":true}\n');
    let modelResult: Record<string, unknown> | undefined;
    const turn = turnRecord(fixture.root, { turnId: "guided-turn-time-context" });
    const agent = fixture.agent(async (options) => {
      modelResult = await options.executeTool({
        name: "read_file",
        args: { path: "settings.json" },
        rawArguments: JSON.stringify({ path: "settings.json" }),
      }) as Record<string, unknown>;
      return "확인했습니다.";
    });

    await agent.run({ turn, signal: new AbortController().signal });

    expect(modelResult?.turn_time_remaining_seconds).toBeNumber();
    expect(modelResult?.turn_time_remaining_seconds).toBeGreaterThan(0);
    const persisted = fixture.stores.guidedToolJournal.list(turn.turnId)[0]?.result;
    expect(persisted).toBeDefined();
    expect(persisted as Record<string, unknown>)
      .not.toHaveProperty("turn_time_remaining_seconds");
  } finally {
    fixture.close();
  }
});

test("Guided operational defaults reserve delivery time before the observer deadline", () => {
  expect(DEFAULT_GUIDED_TURN_LEASE_MS).toBe(280_000);
  expect(DEFAULT_GUIDED_FINAL_REPORT_MS).toBe(15_000);
  expect(DEFAULT_GUIDED_TURN_LEASE_MS - DEFAULT_GUIDED_FINAL_REPORT_MS).toBe(265_000);
});

test("Guided operational reporting preserves current and outdated saved result reviews", () => {
  const work: DurableWorkView = {
    workId: "work-completed",
    sessionId: "session-completed",
    scope: { kind: "session", sessionId: "session-completed" },
    origin: { turnId: "turn-completed", messageId: "message-completed" },
    objective: "Build and verify the requested page",
    status: "completed",
    latestResultReview: {
      reviewRevisionId: "review-completed",
      revision: 1,
      subject: "result",
      verdict: "accept",
      summary: "The requested page was built and desktop and mobile rendering passed.",
      corrections: [],
      boundResultRefs: [],
      originTurnId: "turn-completed",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    resultRefs: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const facts = {
    originalRequest: "페이지를 만들어 주세요.",
    work,
    toolCalls: [],
    effects: [],
  };

  expect(guidedOperationalReportPrompt(facts)).toContain(
    "The requested page was built and desktop and mobile rendering passed.",
  );
  const fallback = guidedOperationalFallback(facts);
  expect(fallback).toContain("저장된 Work는 완료 상태");
  expect(fallback).toContain("Saved model result review: accept");
  expect(fallback).toContain("desktop and mobile rendering passed");

  const outdated = {
    ...facts,
    work: {
      ...work,
      status: "open" as const,
      resultRefs: [{
        resultRef: "result-after-review",
        toolCallId: "call-after-review",
        toolName: "read_file",
        status: "completed" as const,
        originTurnId: "turn-completed",
        attachedAt: "2026-08-01T00:01:00.000Z",
      }],
    },
  };
  expect(guidedOperationalReportPrompt(outdated))
    .toContain("Saved model result review (outdated): accept");
  expect(guidedOperationalFallback(outdated))
    .toContain("Saved model result review (outdated): accept");
});

test("Guided operational fallback is captured before the final report model call", async () => {
  const toolCall = {
    callId: "guided-fallback-precomputed-call",
    toolName: "read_file",
    rawArguments: "{}",
    arguments: {},
    status: "started" as "started" | "completed",
    result: { marker: "captured-before-report-model" },
  };
  let calls = 0;

  const answer = await runGuidedPromptWithOperationalReport({
    promptRunner: async () => {
      calls += 1;
      if (calls === 2) {
        toolCall.status = "completed";
        toolCall.result = { marker: "mutated-during-report-model" };
      }
      if (calls === 1) throw knownProviderFailure("main provider failure");
      throw new Error("final report provider failure");
    },
    options: {
      prompt: "현재까지 확인한 내용을 알려 주세요.",
      tools: [],
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    leaseStartedAt: Date.now(),
    originalRequest: "현재까지 확인한 내용을 알려 주세요.",
    leaseMs: 1_000,
    finalReportMs: 500,
    loadFacts: async () => ({
      work: null,
      toolCalls: [toolCall],
      effects: [],
    }),
  });

  expect(calls).toBe(2);
  expect(answer).toContain("Tool read_file: started");
  expect(answer).not.toContain("Tool read_file: completed");
  expect(answer).not.toContain("captured-before-report-model");
  expect(answer).not.toContain("mutated-during-report-model");
});

test("Guided empty main response still receives one fact-based report request", async () => {
  let calls = 0;
  let factLoads = 0;

  const answer = await runGuidedPromptWithOperationalReport({
    promptRunner: async () => {
      calls += 1;
      return calls === 1 ? "   " : "확인된 작업은 없으며 다시 요청할 수 있습니다.";
    },
    options: {
      prompt: "빈 응답을 보고 가능한 실패로 처리해 주세요.",
      tools: [],
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    leaseStartedAt: Date.now(),
    originalRequest: "빈 응답을 보고 가능한 실패로 처리해 주세요.",
    leaseMs: 1_000,
    finalReportMs: 500,
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  });

  expect(answer).toBe("확인된 작업은 없으며 다시 요청할 수 있습니다.");
  expect(calls).toBe(2);
  expect(factLoads).toBe(1);
});

test("Guided unexpected local failure does not start an operational report request", async () => {
  let calls = 0;
  let factLoads = 0;

  await expect(runGuidedPromptWithOperationalReport({
    promptRunner: async () => {
      calls += 1;
      throw new Error("local prompt assembly invariant failed");
    },
    options: {
      prompt: "로컬 오류는 위로 전달해 주세요.",
      tools: [],
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    leaseStartedAt: Date.now(),
    originalRequest: "로컬 오류는 위로 전달해 주세요.",
    leaseMs: 1_000,
    finalReportMs: 500,
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  })).rejects.toThrow("local prompt assembly invariant failed");

  expect(calls).toBe(1);
  expect(factLoads).toBe(0);
});

test("Guided parent cancellation does not deliver an operational fallback", async () => {
  const controller = new AbortController();
  const stopped = new Error("user stopped the Turn");
  let factLoads = 0;
  const running = runGuidedPromptWithOperationalReport({
    promptRunner: async (options) => await new Promise<string>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
        once: true,
      });
    }),
    options: {
      prompt: "중지할 작업",
      tools: [],
      executeTool: async () => undefined,
    },
    parentSignal: controller.signal,
    leaseStartedAt: Date.now(),
    originalRequest: "중지할 작업",
    leaseMs: 1_000,
    finalReportMs: 500,
    loadFacts: async () => {
      factLoads += 1;
      return {
        work: null,
        toolCalls: [],
        effects: [],
      };
    },
  });

  controller.abort(stopped);

  await expect(running).rejects.toThrow("user stopped the Turn");
  expect(factLoads).toBe(0);
});

test("Guided parent cancellation during quiescence preserves the Stop reason", async () => {
  const controller = new AbortController();
  const stopped = new Error("user stopped during settlement");
  let announceWindowExpiry!: () => void;
  const windowExpired = new Promise<void>((resolve) => {
    announceWindowExpiry = resolve;
  });
  let factLoads = 0;
  const running = runGuidedPromptWithOperationalReport({
    promptRunner: async (options) => await new Promise<string>(() => {
      options.signal?.addEventListener("abort", () => announceWindowExpiry(), {
        once: true,
      });
    }),
    options: {
      prompt: "정리 중인 작업을 중지합니다.",
      tools: [],
      executeTool: async () => undefined,
    },
    parentSignal: controller.signal,
    leaseStartedAt: Date.now(),
    originalRequest: "정리 중인 작업을 중지합니다.",
    leaseMs: 80,
    finalReportMs: 40,
    loadFacts: async () => {
      factLoads += 1;
      return { work: null, toolCalls: [], effects: [] };
    },
  });

  await windowExpired;
  controller.abort(stopped);

  await expect(running).rejects.toThrow("user stopped during settlement");
  expect(factLoads).toBe(0);
});

test("Guided timeout gives the child a bounded settlement grace before loading facts", async () => {
  const toolCall = {
    callId: "guided-quiescence-call",
    toolName: "read_file",
    rawArguments: "{}",
    arguments: {},
    status: "started" as "started" | "cancelled",
  };
  let calls = 0;
  let childSettled = false;
  let factLoadSawSettlement = false;

  const answer = await runGuidedPromptWithOperationalReport({
    promptRunner: async (options) => {
      calls += 1;
      if (calls === 2) throw new Error("final report provider failure");
      return await new Promise<string>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          setTimeout(() => {
            toolCall.status = "cancelled";
            childSettled = true;
            reject(options.signal?.reason);
          }, 1);
        }, { once: true });
      });
    },
    options: {
      prompt: "파일 확인 상태를 알려 주세요.",
      tools: [],
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    leaseStartedAt: Date.now(),
    originalRequest: "파일 확인 상태를 알려 주세요.",
    leaseMs: 80,
    finalReportMs: 40,
    loadFacts: async () => {
      factLoadSawSettlement = childSettled;
      return {
        work: null,
        toolCalls: [toolCall],
        effects: [],
      };
    },
  });

  expect(factLoadSawSettlement).toBe(true);
  expect(answer).toContain("Tool read_file: cancelled");
});

test("Guided fallback does not wait past the lease for a late fact snapshot", async () => {
  let calls = 0;
  const startedAt = Date.now();
  const answer = await runGuidedPromptWithOperationalReport({
    promptRunner: async () => {
      calls += 1;
      throw knownProviderFailure("provider unavailable");
    },
    options: {
      prompt: "늦은 사실 조회를 기다리지 마세요.",
      tools: [],
      executeTool: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    leaseStartedAt: Date.now(),
    originalRequest: "늦은 사실 조회를 기다리지 마세요.",
    leaseMs: 60,
    finalReportMs: 30,
    loadFacts: async () => await new Promise<never>(() => {}),
  });

  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(calls).toBe(1);
  expect(answer).toContain("영속 기록은 없습니다");
  expect(answer).not.toContain("저장된 Work에서 이어갈 수 있습니다");
});

test("Guided agent bounds the main loop and falls back after one failed final report", async () => {
  const fixture = createFixture("guided-lease-fallback");
  try {
    let calls = 0;
    const preservedDraft = `확인 중인 초안 ${"가".repeat(600)} 초안 끝`;
    const agent = fixture.agent(async (options) => {
      calls += 1;
      if (calls === 2) throw new Error("final report provider failure");
      await options.onAssistantTextBeforeTools?.({
        text: preservedDraft,
        toolCalls: [],
      });
      return await new Promise<string>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    }, { turnLeaseMs: 80, finalReportMs: 40 });

    const startedAt = Date.now();
    const outcome = await agent.run({
      turn: turnRecord(fixture.root, { turnId: "guided-lease-turn" }),
      signal: new AbortController().signal,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toBe(2);
    expect(outcome.route).toBe("direct");
    expect(outcome.content).toContain("모델 연결 또는 실행 시간이 종료");
    expect(outcome.content).not.toContain(preservedDraft);
    expect(outcome.content).toContain("완료로 처리하지 않았");
    expect(outcome.content).not.toContain("저장된 Work에서 이어갈 수 있습니다");
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
    dbPath,
    stores,
    agent(
      promptRunner: Parameters<typeof createProductionGuidedTurnAgent>[0]["promptRunner"],
      operational: Pick<
        Parameters<typeof createProductionGuidedTurnAgent>[0],
        "turnLeaseMs" | "finalReportMs"
      > & { butlerHome?: string } = {},
    ) {
      const { butlerHome = root, ...timing } = operational;
      return createProductionGuidedTurnAgent({
        butlerHome,
        butlerData: root,
        appMessageDbPath: dbPath,
        contextDocuments: stores.contextDocuments,
        toolJournal: stores.guidedToolJournal,
        effectJournal: stores.guidedEffectJournal,
        durableWork: stores.durableWork,
        promptRunner,
        ...timing,
      });
    },
    close() {
      stores.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function prepareAppProjectsTable(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      workspace_path TEXT,
      workspace_label TEXT,
      safe_path_label TEXT,
      ledger_project_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);
  } finally {
    db.close(false);
  }
}

function bindAppProject(
  dbPath: string,
  input: {
    id: string;
    workspacePath: string;
    ledgerProjectId: string;
    archived?: boolean;
  },
): void {
  prepareAppProjectsTable(dbPath);
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO projects (
        id, display_name, workspace_path, workspace_label, safe_path_label,
        ledger_project_id, archived, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.id,
      input.workspacePath,
      input.id,
      input.ledgerProjectId,
      input.ledgerProjectId,
      input.archived ? 1 : 0,
      "2026-07-31T00:00:00.000Z",
    );
  } finally {
    db.close(false);
  }
}

function fixtureMcpServerEval(): string {
  return `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";

    const server = new McpServer({ name: "guided-tool-fixture", version: "1.0.0" });
    server.tool("find_issue", "Find issue records", { query: z.string() }, async ({ query }) => ({
      content: [{ type: "text", text: "issue:" + query }],
    }));
    server.resource("fixture", "butler://fixture", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture" }],
    }));
    await server.connect(new StdioServerTransport());
  `;
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

function knownProviderFailure(message: string): ModelProviderRequestError {
  return new ModelProviderRequestError({
    code: "provider_api_error",
    message,
    provider: "test-provider",
    api: "test-api",
    retryable: true,
  });
}

function localRunCommand(
  workspacePath: string,
  turnId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-local-session",
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "기존 파일을 작게 수정해 주세요",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: ["workspace"],
        requiredNativeTools: [],
        workspacePath,
      },
    },
  };
}

function projectRunCommand(
  workspacePath: string,
  turnId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-project-session",
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "프로젝트 작업을 만들고 기록해 주세요",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      projectRef: "guided-project-session",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "ledger",
        requiredNativeToolProfiles: ["workspace", "project", "project-lifecycle"],
        requiredNativeTools: [],
        workspacePath,
        projectId: "guided-project-session",
      },
    },
  };
}
