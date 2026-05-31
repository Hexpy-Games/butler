import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentRuntimeAdapter,
  InboundEnvelope,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import {
  inspectProjectCapsule,
  refreshProjectCapsule,
  refreshRegisteredProjectCapsules,
} from "../../packages/butler-agent/src/agent/cognition/memory/project-memory.ts";
import { recallMemoryEvidence } from "../../packages/butler-agent/src/agent/cognition/memory/quality.ts";

class CapturingRuntime implements AgentRuntimeAdapter {
  readonly id = "capturing-runtime";
  readonly inits: RuntimeSessionInit[] = [];
  readonly turns: RuntimeTurnInput[] = [];
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    this.inits.push(input);
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `capture:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.turns.push(input);
    return {
      text: "project memory loaded",
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }
}

const fakeProvider: ModelProviderAdapter = {
  id: "fake-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "unused" };
  },
};

function envelope(transport = "mock", messageId = "msg-1"): InboundEnvelope {
  return {
    eventId: `${transport}:project-memory-steward:${messageId}`,
    transport,
    accountId: "default",
    peer: { kind: "dm", id: "peer-1" },
    sender: { id: "user-1" },
    message: {
      id: messageId,
      text: "continue the Butler project",
      timestamp: new Date(0).toISOString(),
    },
    routingHints: {
      projectId: "butler",
    },
  };
}

for (const transport of ["mock", "alt-mock"]) {
  test(`project-routed steward turn receives project memory on ${transport} transport`, async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-project-memory-runtime-"));
    const butlerHome = join(root, "home");
    const butlerData = join(root, "data");
    const workspacePath = join(root, "workspace");

    mkdirSync(butlerData, { recursive: true });
    mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
    mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
    mkdirSync(join(butlerData, "cognition", "memory", "projects"), { recursive: true });
    mkdirSync(join(workspacePath, ".butler"), { recursive: true });
    writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT", "utf8");
    writeFileSync(join(butlerHome, "resources", "prompts", "steward.md"), "STEWARD_RULES", "utf8");
    writeFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), "PROJECT_CAPSULE", "utf8");
    writeFileSync(join(workspacePath, ".butler", "hot-cache.md"), "PROJECT_HOT_CACHE", "utf8");

    try {
      const store = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"));
      const runtime = new CapturingRuntime();
      store.upsert({
        sessionId: "steward/butler",
        role: "steward",
        projectId: "butler",
        workspacePath,
        runtimeAdapterId: runtime.id,
        modelProviderId: fakeProvider.id,
        modelRef: "openai/auto:codex-latest",
        transportBindings: [],
      });

      const router = new GatewayRouter({ store });
      const lifecycle = new SessionLifecycleService({
        store,
        runtime,
        provider: fakeProvider,
        promptAssembler: new PromptAssembler({ butlerHome, butlerData }),
      });
      const server = createGatewayServer({
        router,
        handlers: createLifecycleGatewayHandlers(lifecycle),
      });

      const result = await server.handleInbound(envelope(transport));
      expect(result.status).toBe("handled");
      expect(runtime.inits[0]!.systemPrompt).toContain("STEWARD_RULES");
      expect(runtime.inits[0]!.systemPrompt).not.toContain("PROJECT_CAPSULE");

      const promptContext = runtime.turns[0]!.metadata?.promptContext;
      expect(promptContext).toContain("Session Role: steward");
      expect(promptContext).toContain("Project ID: butler");
      expect(promptContext).toContain("Project Memory Status: present");
      expect(promptContext).toContain(`Workspace Path: ${workspacePath}`);
      expect(promptContext).toContain("PROJECT_CAPSULE");
      expect(promptContext).toContain("PROJECT_HOT_CACHE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("steward lifecycle creates a missing project capsule before first turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-memory-lifecycle-"));
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");

  mkdirSync(butlerData, { recursive: true });
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
  mkdirSync(join(workspacePath, ".butler"), { recursive: true });
  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "steward.md"), "STEWARD_RULES", "utf8");
  writeFileSync(join(butlerData, "butler.config.json"), `${JSON.stringify({
    projects: [{ name: "butler", path: workspacePath, description: "Butler runtime" }],
  })}\n`, "utf8");
  writeFileSync(join(workspacePath, ".butler", "hot-cache.md"), "Lifecycle PM-3 hot cache.\n", "utf8");

  try {
    const store = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"));
    const runtime = new CapturingRuntime();
    store.upsert({
      sessionId: "steward/butler",
      role: "steward",
      projectId: "butler",
      workspacePath,
      runtimeAdapterId: runtime.id,
      modelProviderId: fakeProvider.id,
      modelRef: "openai/auto:codex-latest",
      transportBindings: [],
    });

    const server = createGatewayServer({
      router: new GatewayRouter({ store }),
      handlers: createLifecycleGatewayHandlers(new SessionLifecycleService({
        store,
        runtime,
        provider: fakeProvider,
        promptAssembler: new PromptAssembler({ butlerHome, butlerData }),
      })),
    });
    const result = await server.handleInbound(envelope());
    const capsulePath = join(butlerData, "cognition", "memory", "projects", "butler.md");
    const promptContext = String(runtime.turns[0]!.metadata?.promptContext);

    expect(result.status).toBe("handled");
    expect(promptContext).toContain("Project Memory Status: missing");
    expect(promptContext).not.toContain("## Project Memory");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(capsulePath)).toBe(true);
    expect(readFileSync(capsulePath, "utf8")).toContain("Lifecycle PM-3 hot cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent project-routed turns share one steward actor", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-memory-concurrent-"));
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "projects"), { recursive: true });
  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "steward.md"), "STEWARD_RULES", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), "PROJECT_CAPSULE", "utf8");

  try {
    const store = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"));
    const runtime = new CapturingRuntime();
    store.upsert({
      sessionId: "steward/butler",
      role: "steward",
      projectId: "butler",
      workspacePath,
      runtimeAdapterId: runtime.id,
      modelProviderId: fakeProvider.id,
      modelRef: "openai/auto:codex-latest",
      transportBindings: [],
    });
    const server = createGatewayServer({
      router: new GatewayRouter({ store }),
      handlers: createLifecycleGatewayHandlers(new SessionLifecycleService({
        store,
        runtime,
        provider: fakeProvider,
        promptAssembler: new PromptAssembler({ butlerHome, butlerData }),
      })),
    });

    await Promise.all([
      server.handleInbound(envelope("mock", "msg-1")),
      server.handleInbound(envelope("mock", "msg-2")),
    ]);

    expect(runtime.inits).toHaveLength(1);
    expect(runtime.turns).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project capsule refresh writes bounded prompt-ready memory with provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-capsule-refresh-"));
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerData, "tasks", "202604270002"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "tasks"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "rules", "projects"), { recursive: true });
  mkdirSync(join(workspacePath, ".butler"), { recursive: true });
  writeFileSync(join(butlerData, "butler.config.json"), `${JSON.stringify({
    projects: [{
      name: "butler",
      path: workspacePath,
      description: "Native API-backed personal automation service.",
      aliases: ["assistant-runtime"],
    }],
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270002", "project"), `${workspacePath}\n`, "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270002", "status"), "DONE\n", "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270002", "request.md"), "Implement project memory PM-2\n", "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270002", "result.md"), "Refresh CLI now writes capsules.\n", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "tasks", "butler-note.md"), "butler memory evidence\n", "utf8");
  writeFileSync(
    join(butlerData, "cognition", "memory", "rules", "projects", "butler.md"),
    "Always keep project memory explicit feedback ahead of inferred hot notes.\n",
    "utf8",
  );
  writeFileSync(join(workspacePath, ".butler", "hot-cache.md"), "Recent PM-2 feedback should stay project scoped.\n", "utf8");

  try {
    const result = refreshProjectCapsule({
      butlerData,
      projectId: "butler",
      now: "2026-04-27T00:00:00.000Z",
      maxBytes: 4_000,
    });
    const body = readFileSync(result.path, "utf8");

    expect(result).toMatchObject({
      ok: true,
      projectId: "butler",
      sourceCounts: {
        registry: 1,
        tasks: 1,
        explicitFeedback: 1,
        projectHotCache: 1,
        memoryEvidence: 1,
      },
    });
    expect(result.bytes).toBeLessThanOrEqual(4_000);
    expect(body).toContain("# Project Memory: butler");
    expect(body).toContain("## Identity");
    expect(body).toContain("## Active Work");
    expect(body).toContain("Implement project memory PM-2");
    expect(body).toContain("provenance: task:202604270002");
    expect(body).toContain("Explicit project feedback");
    expect(body).toContain("provenance: project-hot-cache:");
    expect(body).toContain("memory-evidence:");
    expect(body.indexOf("Explicit project feedback")).toBeLessThan(body.indexOf("Recent project-local notes"));
    expect(existsSync(join(butlerData, "cognition", "memory", "locks", "project-capsules", "butler.lock"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project capsule refresh promotes repeated project signals from distinct evidence sources", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-capsule-promotion-"));
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerData, "tasks", "202604270003"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "tasks"), { recursive: true });
  mkdirSync(join(workspacePath, ".butler"), { recursive: true });
  writeFileSync(join(butlerData, "butler.config.json"), `${JSON.stringify({
    projects: [{ name: "butler", path: workspacePath }],
  })}\n`, "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270003", "project"), "butler\n", "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270003", "status"), "DONE\n", "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270003", "request.md"), "Decision: Single task echo must not promote alone.\n", "utf8");
  writeFileSync(join(butlerData, "tasks", "202604270003", "result.md"), [
    "Decision: Single task echo must not promote alone.",
    "Decision: DuckDuckGo is the default search provider.",
    "Risk: Old Jina reader is deprecated.",
    "This single-source-only note must not be promoted.",
  ].join("\n"), "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "tasks", "butler-search.md"), [
    "butler",
    "Decision: DuckDuckGo is the default search provider.",
    "Risk: Old Jina reader is deprecated.",
    "Risk: raw memory dumps must stay out of reports.",
  ].join("\n"), "utf8");
  writeFileSync(join(workspacePath, ".butler", "hot-cache.md"), [
    "Decision: DuckDuckGo is the default search provider.",
    "Risk: raw memory dumps must stay out of reports.",
  ].join("\n"), "utf8");

  try {
    const result = refreshRegisteredProjectCapsules({
      butlerData,
      now: "2026-04-27T01:00:00.000Z",
    });
    expect(result.refreshed).toBe(1);
    expect(result.failed).toEqual([]);

    const capsulePath = join(butlerData, "cognition", "memory", "projects", "butler.md");
    const body = readFileSync(capsulePath, "utf8");
    expect(body).toContain("DuckDuckGo is the default search provider");
    expect(body).toContain("provenance: promoted:decisions");
    expect(body).toContain("sources=3");
    expect(body).toContain("raw memory dumps must stay out of reports");
    expect(body).toContain("provenance: promoted:risks");
    expect(body).not.toContain("single-source-only note (provenance: promoted");
    expect(body).not.toContain("Single task echo must not promote alone. (provenance: promoted");
    const decisionsSection = body.match(/## Decisions\n(?<content>[\s\S]*?)\n## Feedback/u)?.groups?.content ?? "";
    const risksSection = body.match(/## Risks\n(?<content>[\s\S]*?)\n## Freshness/u)?.groups?.content ?? "";
    expect(decisionsSection).not.toContain("Old Jina reader is deprecated");
    expect(risksSection).toContain("Old Jina reader is deprecated");

    const inspect = inspectProjectCapsule({ butlerData, projectId: "butler" });
    expect(inspect.exists).toBe(true);
    expect(inspect.sourceCounts?.promoted).toBeGreaterThanOrEqual(2);
    expect(inspect.sectionHeadings).toContain("Decisions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project capsule inspect reports safe diagnostics and persisted refresh failures", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-capsule-inspect-"));
  const butlerData = join(root, "data");
  mkdirSync(join(butlerData, "cognition", "memory", "locks", "project-capsules"), { recursive: true });
  writeFileSync(join(butlerData, "cognition", "memory", "locks", "project-capsules", "butler.lock"), "existing\n", "utf8");

  try {
    expect(() => refreshProjectCapsule({
      butlerData,
      projectId: "butler",
      now: "2026-04-27T02:00:00.000Z",
    })).toThrow("project capsule refresh already running for butler");

    const missing = inspectProjectCapsule({ butlerData, projectId: "butler" });
    expect(missing.exists).toBe(false);
    expect(missing.refreshFailures.count).toBe(1);
    expect(missing.refreshFailures.latest?.message).toContain("already running");
    expect(missing.diagnostics).toContain("project capsule is missing");

    rmSync(join(butlerData, "cognition", "memory", "locks", "project-capsules", "butler.lock"), { force: true });
    refreshProjectCapsule({
      butlerData,
      projectId: "butler",
      now: "2026-04-27T02:01:00.000Z",
    });
    const present = inspectProjectCapsule({ butlerData, projectId: "butler" });
    expect(present.exists).toBe(true);
    expect(present.bytes).toBeGreaterThan(0);
    expect(present.sourceCounts?.registry).toBe(0);
    expect(JSON.stringify(present)).not.toContain("# Project Memory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered project capsule maintenance uses per-project locks for concurrent refresh races", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-capsule-maintenance-lock-"));
  const butlerData = join(root, "data");
  mkdirSync(join(butlerData, "cognition", "memory", "locks", "project-capsules"), { recursive: true });
  writeFileSync(join(butlerData, "butler.config.json"), `${JSON.stringify({
    projects: [{ name: "butler", path: join(root, "workspace") }],
  })}\n`, "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "locks", "project-capsules", "butler.lock"), "existing\n", "utf8");

  try {
    const result = refreshRegisteredProjectCapsules({
      butlerData,
      now: "2026-04-27T02:02:00.000Z",
    });
    expect(result).toMatchObject({
      considered: 1,
      refreshed: 0,
      failed: [{
        projectId: "butler",
        message: "project capsule refresh already running for butler",
      }],
    });

    const inspect = inspectProjectCapsule({ butlerData, projectId: "butler" });
    expect(inspect.refreshFailures.count).toBe(1);
    expect(inspect.refreshFailures.latest?.phase).toBe("lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project capsule refresh rejects concurrent refresh locks", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-capsule-lock-"));
  const butlerData = join(root, "data");
  mkdirSync(join(butlerData, "cognition", "memory", "locks", "project-capsules"), { recursive: true });
  writeFileSync(join(butlerData, "cognition", "memory", "locks", "project-capsules", "butler.lock"), "existing\n", "utf8");

  try {
    expect(() => refreshProjectCapsule({
      butlerData,
      projectId: "butler",
    })).toThrow("already running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project capsule refresh recovers stale lock files", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-capsule-stale-lock-"));
  const butlerData = join(root, "data");
  const lockPath = join(butlerData, "cognition", "memory", "locks", "project-capsules", "butler.lock");
  mkdirSync(join(butlerData, "cognition", "memory", "locks", "project-capsules"), { recursive: true });
  writeFileSync(lockPath, "{\"pid\":99999999}\n", "utf8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);

  try {
    const result = refreshProjectCapsule({
      butlerData,
      projectId: "butler",
    });
    expect(result.ok).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project capsule refresh expires hung live-pid locks after ttl", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-capsule-hung-lock-"));
  const butlerData = join(root, "data");
  const lockPath = join(butlerData, "cognition", "memory", "locks", "project-capsules", "butler.lock");
  mkdirSync(join(butlerData, "cognition", "memory", "locks", "project-capsules"), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);

  try {
    const result = refreshProjectCapsule({
      butlerData,
      projectId: "butler",
      lockStaleAfterMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-scoped recall filters project memory capsules by project id", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-scoped-recall-"));
  const butlerData = join(root, "data");
  mkdirSync(join(butlerData, "cognition", "memory", "projects"), { recursive: true });
  writeFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), "Shared provider decision: use DuckDuckGo for Butler.\n", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "projects", "homepage.md"), "Shared provider decision: use Cloudflare Pages for homepage.\n", "utf8");

  try {
    const butler = recallMemoryEvidence({
      butlerData,
      cue: "shared provider decision",
      projectId: "butler",
    });
    const homepage = recallMemoryEvidence({
      butlerData,
      cue: "shared provider decision",
      projectId: "homepage",
    });

    expect(butler.results.some((item) => item.path.endsWith("butler.md"))).toBe(true);
    expect(butler.results.some((item) => item.path.endsWith("homepage.md"))).toBe(false);
    expect(homepage.results.some((item) => item.path.endsWith("homepage.md"))).toBe(true);
    expect(homepage.results.some((item) => item.path.endsWith("butler.md"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
