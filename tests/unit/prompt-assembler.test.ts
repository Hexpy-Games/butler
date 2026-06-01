import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  classifyPromptSection,
  stablePromptPrefixHash,
} from "../../packages/butler-agent/src/agent/context/prompt-cache-policy.ts";
import { projectMemoryPath, sanitizeProjectMemoryId } from "../../packages/butler-agent/src/agent/cognition/memory/project-memory.ts";
import { addFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import { writeRuntimeProfileProjection } from "../../packages/butler-agent/src/personalization/profiling.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";

function binding(
  workspacePath: string,
  overrides: Partial<Pick<StoredSessionBinding, "role" | "projectId" | "sessionId">> = {},
): StoredSessionBinding {
  const now = new Date(0).toISOString();
  return {
    sessionId: overrides.sessionId ?? "butler/main",
    role: overrides.role ?? "butler",
    projectId: overrides.projectId ?? "butler",
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
    metadata: {},
    lifecycleState: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function assembledTurnContext(
  assembler: PromptAssembler,
  session: StoredSessionBinding,
  text = "hello",
): string {
  return assembler.buildTurnContext({
    binding: session,
    envelope: {
      eventId: "mock:turn-context",
      transport: "mock",
      accountId: "default",
      peer: { kind: "dm", id: "peer-1" },
      sender: { id: "user-1" },
      message: {
        id: "msg-1",
        text,
        timestamp: new Date(0).toISOString(),
      },
    },
  });
}

function turnContextSectionIds(turnContext: string): string[] {
  const titleToId = new Map([
    ["Active Persona Reminder", "active-persona-reminder"],
    ["Personalization Profile", "turn-personalization-profile"],
    ["First-Chat Onboarding", "first-chat-onboarding"],
    ["Active Feedback Buffer", "feedback-buffer"],
    ["Profile Projection", "profile-projection"],
    ["Hot Cache", "hot-cache"],
    ["Project Memory", "project-memory"],
    ["Project Hot Cache", "project-hot-cache"],
  ]);
  return [...turnContext.matchAll(/^## (.+)$/gmu)]
    .map((match) => titleToId.get(match[1] ?? ""))
    .filter((id): id is string => Boolean(id));
}

test("prompt cache policy rejects unknown section ids instead of treating them as stable", () => {
  expect(() => classifyPromptSection("unregistered-section")).toThrow(
    "Unknown prompt section stability: unregistered-section",
  );
});

test("butler static prompt excludes live configuration while turn context carries latest live config", () => {
  const root = join(tmpdir(), `butler-prompt-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills", "status"), { recursive: true });
  mkdirSync(join(butlerData, "skills", "default", "memory-audit"), { recursive: true });
  mkdirSync(join(butlerData, "skills", "projects", "butler", "release-check"), { recursive: true });
  mkdirSync(join(butlerData, "personas"), { recursive: true });
  mkdirSync(join(butlerData, "personalization"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory"), { recursive: true });

  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT_SENTINEL", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "BUTLER_SENTINEL", "utf8");
  writeFileSync(join(butlerData, "eol.md"), "PRIVATE_EOL_SENTINEL", "utf8");
  writeFileSync(join(butlerData, "personas", "active.md"), "PERSONA_SENTINEL", "utf8");
  writeFileSync(
    join(butlerData, "personalization", "profile.json"),
    JSON.stringify({
      butler_nickname: "Alfred",
      principal_name: "Bruce Wayne",
      preferred_address: "Master Wayne",
      updated_at: "2026-05-16T00:00:00.000Z",
    }),
    "utf8",
  );
  writeFileSync(join(butlerData, "cognition", "memory", "user-profile.md"), "PROFILE_SENTINEL", "utf8");
  writeRuntimeProfileProjection(butlerData, {
    version: 3,
    mode: "deep",
    updated_at: "2026-05-16T00:00:00.000Z",
    how_to_answer: ["Prefer concise verified reports."],
    how_to_collaborate: [],
    response_hints: ["Prefer concise verified reports."],
    current_attention: ["Butler profiling architecture is active."],
    active_boundaries: ["Do not expose raw profile data."],
    likely_failure_modes: [],
    ask_before: [],
    caution_hints: ["Do not expose raw profile data."],
  });
  writeFileSync(join(butlerHome, "resources", "skills", "status", "SKILL.md"), `---
name: status
description: Status skill sentinel.
user-invocable: true
applicability: Use when the model decides status is relevant.
allowed-tools: get_work_dashboard
dispatch: none
review: none
reporting: Report status.
---

STATUS_SKILL_SENTINEL
`, "utf8");
  writeFileSync(join(butlerData, "skills", "default", "memory-audit", "SKILL.md"), `---
name: memory-audit
description: User skill sentinel.
user-invocable: true
applicability: Use when the model decides memory audit is relevant.
allowed-tools: none
dispatch: none
review: none
reporting: Report memory.
---

USER_SKILL_SENTINEL
`, "utf8");
  writeFileSync(join(butlerData, "skills", "projects", "butler", "release-check", "SKILL.md"), `---
name: release-check
description: Project skill sentinel.
user-invocable: true
applicability: Use when the model decides release check is relevant.
allowed-tools: none
dispatch: none
review: none
reporting: Report release.
---

PROJECT_SKILL_SENTINEL
`, "utf8");

  try {
    const assembled = new PromptAssembler({ butlerHome, butlerData }).buildSystemPrompt(binding(butlerHome));
    expect(assembled.systemPrompt).toContain("RUNTIME_CONTRACT_SENTINEL");
    expect(assembled.systemPrompt).toContain("BUTLER_SENTINEL");
    expect(assembled.systemPrompt).not.toContain("PRIVATE_EOL_SENTINEL");
    expect(assembled.systemPrompt).not.toContain("PERSONA_SENTINEL");
    expect(assembled.systemPrompt).not.toContain("Butler nickname: Alfred");
    expect(assembled.systemPrompt).not.toContain("Address the principal as: Master Wayne");
    expect(assembled.systemPrompt).not.toContain("PROFILE_SENTINEL");
    expect(assembled.systemPrompt).not.toContain("Prefer concise verified reports.");
    expect(assembled.systemPrompt).not.toContain("Do not expose raw profile data.");
    expect(assembled.systemPrompt).not.toContain("Status skill sentinel.");
    expect(assembled.sections.map((section) => section.id)).toEqual([
      "runtime-system-contract",
      "role",
    ]);
    const turnContext = assembledTurnContext(
      new PromptAssembler({ butlerHome, butlerData }),
      binding(butlerHome),
    );
    expect(turnContext).toContain("PRIVATE_EOL_SENTINEL");
    expect(turnContext).toContain("PERSONA_SENTINEL");
    expect(turnContext).toContain("Butler nickname: Alfred");
    expect(turnContext).toContain("Address the principal as: Master Wayne");
    expect(turnContext).not.toContain("Status skill sentinel.");
    expect(turnContext).not.toContain("User skill sentinel.");
    expect(turnContext).not.toContain("Project skill sentinel.");
    expect(turnContext).toContain("Prefer concise verified reports.");
    expect(turnContext).toContain("Do not expose raw profile data.");

    const skillTurnContext = assembledTurnContext(
      new PromptAssembler({ butlerHome, butlerData }),
      binding(butlerHome),
      "status memory release",
    );
    expect(skillTurnContext).not.toContain("Status skill sentinel.");
    expect(skillTurnContext).not.toContain("User skill sentinel.");
    expect(skillTurnContext).not.toContain("Project skill sentinel.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default Butler prompt documents concrete todo-list decision examples", () => {
  const prompt = readFileSync(
    join(process.cwd(), "packages", "butler-agent", "resources", "prompts", "butler.md"),
    "utf8",
  );

  expect(prompt).toContain("Use a todo list for requests like:");
  expect(prompt).toContain("Refactor the web search pipeline, add tests, and validate the transport flow.");
  expect(prompt).toContain("Do not use a todo list for requests like:");
  expect(prompt).toContain("What time is it?");
});

test("context assembly separates static live runtime retrieved and current input regions", () => {
  const root = join(tmpdir(), `butler-context-assembly-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerData, "personas"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "projects"), { recursive: true });

  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "BUTLER_ROLE", "utf8");
  writeFileSync(join(butlerData, "personas", "active.md"), "PERSONA_BODY", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), "PROJECT_MEMORY", "utf8");

  try {
    const assembler = new PromptAssembler({ butlerHome, butlerData });
    const session = binding(workspacePath, {
      role: "butler",
      sessionId: "butler/context-assembly",
      projectId: "butler",
    });
    const todo = new TodoListStore(butlerData).update({
      listId: "ctx",
      title: "Context refactor",
      items: [{
        id: "inspect",
        content: "Inspect context state",
        active_form: "Inspecting context state.",
        status: "in_progress",
        phase: "execution",
      }],
    });
    const workStreamStore = new WorkStreamStore(butlerData);
    const stream = workStreamStore.updateFromTodoList({
      ownerSessionId: session.sessionId,
      projectId: "butler",
      listId: todo.list.list_id,
      title: "Context refactor",
      items: todo.items,
    });
    mkdirSync(join(butlerData, "tasks", "worker-ctx"), { recursive: true });
    writeFileSync(join(butlerData, "tasks", "worker-ctx", "status"), "RUNNING\n", "utf8");
    writeFileSync(join(butlerData, "tasks", "worker-ctx", "request.md"), "Inspect worker context continuity.\n", "utf8");
    workStreamStore.link({
      id: stream.id,
      workerTaskIds: ["worker-ctx"],
    });
    const assembly = assembler.buildContextAssembly({
      binding: session,
      envelope: {
        eventId: "mock:assembly",
        transport: "mock",
        accountId: "default",
        peer: { kind: "dm", id: "peer-1" },
        sender: { id: "user-1" },
        message: {
          id: "msg-assembly",
          text: "이전 내용 이어서 정리해줘",
          timestamp: new Date(0).toISOString(),
          attachments: [{
            id: "file-00000000-0000-4000-8000-000000000123",
            kind: "document",
            mimeType: "text/markdown",
            fileName: "notes.md",
            sizeBytes: 1234,
          }],
        },
      },
    });

    expect(assembly.staticContext.map((section) => section.id)).toEqual([
      "runtime-system-contract",
      "role",
    ]);
    expect(assembly.liveConfiguration.map((section) => section.id)).toContain("active-persona-reminder");
    expect(assembly.runtimeState.map((section) => section.id)).toEqual([
      "runtime-state",
      "first-chat-onboarding",
    ]);
    expect(assembly.runtimeState[0]!.content).toContain("## Active Work State");
    expect(assembly.runtimeState[0]!.content).toContain("WorkStream State: executing");
    expect(assembly.runtimeState[0]!.content).toContain("Current Todo: Inspecting context state.");
    expect(assembly.runtimeState[0]!.content).toContain("Linked Workers:");
    expect(assembly.runtimeState[0]!.content).toContain("worker-ctx: RUNNING");
    expect(assembly.runtimeState[0]!.content).not.toContain("Transport:");
    expect(assembly.runtimeState[0]!.content).not.toContain("Peer Kind:");
    expect(assembly.runtimeState[0]!.content).not.toContain("Peer ID:");
    expect(assembly.runtimeState[0]!.content).not.toContain("Message ID:");
    expect(assembly.runtimeState[0]!.content).not.toContain("Route Reason:");
    expect(assembly.runtimeState[1]!.content).toContain("First-chat onboarding is still pending.");
    expect(assembly.retrievedContext.map((section) => section.id)).toContain("project-memory");
    expect(assembly.workingContext).toEqual([
      expect.objectContaining({
        id: "current-attachments",
        region: "working_context",
        content: expect.stringContaining("attachment_id: file-00000000-0000-4000-8000-000000000123"),
      }),
    ]);
    expect(assembly.currentInput).toEqual([
      expect.objectContaining({
        id: "inbound-message",
        region: "current_input",
        content: "Message Text: 이전 내용 이어서 정리해줘",
      }),
    ]);
    expect(assembly.references).toContainEqual(expect.objectContaining({
      kind: "attachment",
      id: "file-00000000-0000-4000-8000-000000000123",
      label: "notes.md",
    }));
    expect(assembly.liveConfigHash).toMatch(/^[a-f0-9]{16}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project memory and project hot cache are dynamic turn context", () => {
  const root = join(tmpdir(), `butler-project-memory-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "hot"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "projects"), { recursive: true });
  mkdirSync(join(workspacePath, ".butler"), { recursive: true });

  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT_STABLE", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "steward.md"), "STEWARD_STABLE", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "hot", "cache.md"), "GLOBAL_HOT_SENTINEL", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), "PROJECT_MEMORY_SENTINEL", "utf8");
  writeFileSync(join(workspacePath, ".butler", "hot-cache.md"), "PROJECT_HOT_SENTINEL", "utf8");

  try {
    const assembler = new PromptAssembler({ butlerHome, butlerData });
    const session = binding(workspacePath, {
      role: "steward",
      sessionId: "steward/butler",
      projectId: "butler",
    });
    const first = assembler.buildSystemPrompt(session);
    const firstHash = stablePromptPrefixHash(first.sections);
    const turnContext = assembler.buildTurnContext({
      binding: session,
      envelope: {
        eventId: "mock:project-memory",
        transport: "mock",
        accountId: "default",
        peer: { kind: "dm", id: "peer-1" },
        sender: { id: "user-1" },
        message: {
          id: "msg-1",
          text: "continue this project",
          timestamp: new Date(0).toISOString(),
        },
      },
    });

    expect(first.systemPrompt).toContain("RUNTIME_CONTRACT_STABLE");
    expect(first.systemPrompt).toContain("STEWARD_STABLE");
    expect(first.systemPrompt).not.toContain("PROJECT_MEMORY_SENTINEL");
    expect(turnContext).toContain("Project ID: butler");
    expect(turnContext).toContain("Project Memory Status: present");
    expect(turnContext).toContain(`Workspace Path: ${workspacePath}`);
    expect(turnContext).toContain("PROJECT_MEMORY_SENTINEL");
    expect(turnContext).toContain("PROJECT_HOT_SENTINEL");
    expect(turnContext.indexOf("## Project Memory")).toBeLessThan(turnContext.indexOf("## Project Hot Cache"));
    expect(classifyPromptSection("project-memory")).toBe("dynamic-suffix");
    expect(classifyPromptSection("project-hot-cache")).toBe("dynamic-suffix");

    writeFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), "PROJECT_MEMORY_UPDATED", "utf8");
    const secondHash = stablePromptPrefixHash(assembler.buildSystemPrompt(session).sections);
    expect(secondHash).toBe(firstHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn context injects active feedback buffer before profile projection", () => {
  const root = join(tmpdir(), `butler-feedback-prompt-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
  mkdirSync(join(butlerData, "personas"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory"), { recursive: true });

  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT_STABLE", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "BUTLER_STABLE", "utf8");
  writeFileSync(join(butlerData, "personas", "active.md"), "PERSONA_STABLE", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "user-profile.md"), "PROFILE_STABLE", "utf8");
  writeRuntimeProfileProjection(butlerData, {
    version: 1,
    mode: "basic",
    updated_at: "2026-05-16T00:00:00.000Z",
    how_to_answer: ["Keep completion reports brief."],
    how_to_collaborate: [],
    response_hints: ["Keep completion reports brief."],
    current_attention: [],
    active_boundaries: [],
    likely_failure_modes: [],
    ask_before: [],
    caution_hints: [],
  });
  addFeedbackEntry(butlerData, {
    text: "앞으로 이 소스에서는 검색하지 마세요.",
    targetRef: "source:bad-weather",
    category: "source_policy",
    scope: "source",
    promotionTarget: "source_quality",
    priority: "critical",
  });

  try {
    const assembler = new PromptAssembler({ butlerHome, butlerData });
    const assembled = assembler.buildSystemPrompt(binding(butlerHome));
    const turnContext = assembledTurnContext(assembler, binding(butlerHome));
    const turnContextIds = turnContextSectionIds(turnContext);
    expect(assembled.systemPrompt).not.toContain("## Active Feedback Buffer");
    expect(assembled.systemPrompt).not.toContain("앞으로 이 소스에서는 검색하지 마세요.");
    expect(assembled.systemPrompt).not.toContain("PROFILE_STABLE");
    expect(assembled.systemPrompt).not.toContain("Keep completion reports brief.");
    expect(assembled.sections.map((section) => section.id)).toEqual([
      "runtime-system-contract",
      "role",
    ]);
    expect(turnContext).toContain("## Active Feedback Buffer");
    expect(turnContext).toContain("앞으로 이 소스에서는 검색하지 마세요.");
    expect(turnContext).toContain("Keep completion reports brief.");
    expect(turnContextIds).toContain("active-persona-reminder");
    expect(turnContextIds).toEqual(expect.arrayContaining([
      "feedback-buffer",
      "profile-projection",
    ]));
    expect(turnContextIds.indexOf("feedback-buffer")).toBeLessThan(turnContextIds.indexOf("profile-projection"));
    expect(classifyPromptSection("feedback-buffer")).toBe("dynamic-suffix");
    expect(classifyPromptSection("profile-projection")).toBe("dynamic-suffix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn context carries the latest active persona reminder for existing sessions", () => {
  const root = join(tmpdir(), `butler-persona-reminder-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerData, "personas"), { recursive: true });
  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT_STABLE", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "BUTLER_STABLE", "utf8");
  writeFileSync(join(butlerData, "personas", "active.md"), "OLD_PERSONA_STABLE", "utf8");

  try {
    const assembler = new PromptAssembler({ butlerHome, butlerData });
    const session = binding(workspacePath, {
      role: "butler",
      sessionId: "butler/persona-reminder",
      projectId: undefined,
    });
    const first = assembler.buildSystemPrompt(session);
    expect(first.systemPrompt).not.toContain("OLD_PERSONA_STABLE");

    writeFileSync(
      join(butlerData, "personas", "active.md"),
      "NEW_NEKO_PERSONA_SENTINEL\nVoice: end casual answers with 다냐.",
      "utf8",
    );

    const turnContext = assembler.buildTurnContext({
      binding: session,
      envelope: {
        eventId: "mock:persona-reminder",
        transport: "mock",
        accountId: "default",
        peer: { kind: "dm", id: "peer-1" },
        sender: { id: "user-1" },
        message: {
          id: "msg-persona",
          text: "가볍게 대답해줘",
          timestamp: new Date(0).toISOString(),
        },
      },
    });

    expect(turnContext).toContain("## Active Persona Reminder");
    expect(turnContext).toContain("NEW_NEKO_PERSONA_SENTINEL");
    expect(turnContext).toContain("Use the configured Assistant Response Language from the Turn Environment");
    expect(turnContext).toContain("translate or adapt that voice into the configured response language");
    expect(turnContext).toContain("Do not let tool, review, or report formatting instructions erase the persona.");
    expect(turnContext).not.toContain("safety/accuracy requires a calmer voice");
    expect(turnContext).not.toContain("OLD_PERSONA_STABLE");
    expect(classifyPromptSection("active-persona-reminder")).toBe("dynamic-suffix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing project memory degrades while keeping project identity and workspace", () => {
  const root = join(tmpdir(), `butler-project-memory-missing-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT_STABLE", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "steward.md"), "STEWARD_STABLE", "utf8");

  try {
    const session = binding(workspacePath, {
      role: "steward",
      sessionId: "steward/no-capsule",
      projectId: "missing-project",
    });
    const turnContext = new PromptAssembler({ butlerHome, butlerData }).buildTurnContext({
      binding: session,
      envelope: {
        eventId: "mock:missing-project-memory",
        transport: "mock",
        accountId: "default",
        peer: { kind: "dm", id: "peer-1" },
        sender: { id: "user-1" },
        message: {
          id: "msg-1",
          text: "start",
          timestamp: new Date(0).toISOString(),
        },
      },
    });

    expect(turnContext).toContain("Project ID: missing-project");
    expect(turnContext).toContain("Project Memory Status: missing");
    expect(turnContext).toContain(`Workspace Path: ${workspacePath}`);
    expect(turnContext).not.toContain("## Project Memory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn context includes current time, timezone, language, and geo hint", () => {
  const root = join(tmpdir(), `butler-turn-environment-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(butlerData, { recursive: true });
  writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
    user: {
      timezone: "Asia/Seoul",
      language: "ko",
      responseLanguage: "en",
      techLanguage: "en",
      geo: {
        city: "Chungju",
        region: "Chungcheongbuk-do",
        country: "South Korea",
      },
    },
  }), "utf8");

  try {
    const turnContext = new PromptAssembler({ butlerHome, butlerData }).buildTurnContext({
      binding: binding(workspacePath, {
        role: "butler",
        sessionId: "butler/environment",
        projectId: undefined,
      }),
      envelope: {
        eventId: "mock:environment",
        transport: "mock",
        accountId: "default",
        peer: { kind: "dm", id: "peer-1" },
        sender: { id: "user-1" },
        message: {
          id: "msg-env",
          text: "오늘 기준으로 확인해줘",
          timestamp: "2026-05-07T01:21:14.000Z",
        },
      },
    });

    expect(turnContext).toContain("## Turn Environment");
    expect(turnContext).toContain("Current Time UTC: 2026-05-07T01:21:14.000Z");
    expect(turnContext).toContain("User Timezone: Asia/Seoul");
    expect(turnContext).toContain("User Language: ko");
    expect(turnContext).toContain("Assistant Response Language: en");
    expect(turnContext).toContain("User Technical Language: en");
    expect(turnContext).toContain("User Geo Hint: Chungju, Chungcheongbuk-do, South Korea");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project memory id uses minimal filename safety", () => {
  expect(sanitizeProjectMemoryId("team/app\u0000main")).toBe("team_app_main");
  expect(sanitizeProjectMemoryId("버틀러")).toBe("버틀러");
  expect(projectMemoryPath({
    butlerData: "/tmp/butler-data",
    projectId: "team/app",
  })).toBe("/tmp/butler-data/cognition/memory/projects/team_app.md");
  expect(projectMemoryPath({
    butlerData: "/tmp/butler-data",
    projectId: "   ",
  })).toBeNull();
});
