import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeMemoryAttributionPort,
} from "../../packages/butler-agent/src/operations/diagnostics/runtime-memory-attribution/index.ts";
import { recordRuntimeMemoryEvent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/runtime-memory-attribution-events.ts";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-${Date.now()}-`));
}

function fixedCounters() {
  return {
    rss: 11_000,
    heapTotal: 2_000,
    heapUsed: 1_000,
    external: 700,
    arrayBuffers: 500,
  };
}

function lines(root: string, name = "agent-memory-attribution.jsonl"): Record<string, unknown>[] {
  const path = join(root, "diagnostics", name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("memory attribution is disabled by default and performs no sampling or file work", () => {
  const root = tempRoot("agent-memory-attribution-disabled");
  let memoryCalls = 0;
  let heapCalls = 0;
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      processMemoryUsage: () => {
        memoryCalls += 1;
        return fixedCounters();
      },
      heapStats: () => {
        heapCalls += 1;
        return { heapSize: 1, heapCapacity: 2, extraMemorySize: 3, objectCount: 4 };
      },
    });
    port.checkpoint({ event: "turn_start", operation: "turn" });
    port.terminal("delivered");
    port.close();
    expect(memoryCalls).toBe(0);
    expect(heapCalls).toBe(0);
    expect(existsSync(join(root, "diagnostics"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled samples are bounded and contain only allowlisted telemetry", () => {
  const root = tempRoot("agent-memory-attribution-enabled");
  const privateText = "/private/prompt-and-secret-url";
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: { BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1" },
      processMemoryUsage: fixedCounters,
      heapStats: () => ({
        heapSize: 12,
        heapCapacity: 20,
        extraMemorySize: 7,
        objectCount: 9,
      }),
      clock: { monotonicMs: () => 42, wallClockMs: () => 1_000 },
    });
    port.checkpoint({
      event: "tool_call_start",
      operation: "not-a-real-owner" as never,
      iteration: 4,
      ownerCounts: {
        activeToolCalls: 1,
        activeProviderStreams: 0,
      },
    });
    port.close();

    const record = lines(root)[0];
    expect(record).toMatchObject({
      schema: "butler.agent-memory-attribution.v1",
      sequence: 0,
      monotonicMs: 42,
      wallClockMs: 1_000,
      event: "tool_call_start",
      operation: "other",
      iteration: 4,
      process: {
        rssBytes: 11_000,
        externalBytes: 700,
        arrayBufferBytes: 500,
      },
      heap: {
        heapSizeBytes: 12,
        extraMemoryBytes: 7,
      },
      ownerCounts: {
        activeToolCalls: 1,
        activeProviderStreams: 0,
      },
    });
    expect(JSON.stringify(record)).not.toContain(privateText);
    expect(statSync(join(root, "diagnostics")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "diagnostics", "agent-memory-attribution.jsonl")).mode & 0o777)
      .toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider and tool owner counters track success/failure and never go below zero", () => {
  const root = tempRoot("agent-memory-attribution-owners");
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: { BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1" },
      processMemoryUsage: fixedCounters,
      heapStats: () => ({}),
    });
    port.checkpoint({ event: "model_call_end", operation: "provider" });
    port.checkpoint({ event: "tool_call_failure", operation: "other_tool" });
    port.checkpoint({ event: "model_call_start", operation: "provider" });
    port.checkpoint({ event: "tool_call_start", operation: "command" });
    port.checkpoint({ event: "model_call_failure", operation: "provider" });
    port.checkpoint({ event: "tool_call_end", operation: "command" });
    port.close();
    const records = lines(root);
    expect(records.map((record) => record.ownerCounts)).toEqual([
      { activeProviderStreams: 0, activeToolCalls: 0 },
      { activeProviderStreams: 0, activeToolCalls: 0 },
      { activeProviderStreams: 1, activeToolCalls: 0 },
      { activeProviderStreams: 1, activeToolCalls: 1 },
      { activeProviderStreams: 0, activeToolCalls: 1 },
      { activeProviderStreams: 0, activeToolCalls: 0 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled writer persists only allowlisted Project Ledger phase fields", () => {
  const root = tempRoot("agent-memory-attribution-project-ledger-phase");
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: { BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1" },
      processMemoryUsage: fixedCounters,
      heapStats: () => ({}),
    });
    port.projectLedgerPhase({ phase: "source_head", status: "end", durationMs: 42 });
    port.close();
    expect(lines(root)[0]).toMatchObject({
      event: "project_ledger_phase",
      operation: "project_ledger",
      phase: "source_head",
      phaseStatus: "end",
      durationMs: 42,
    });
    expect(JSON.stringify(lines(root)[0])).not.toContain("private");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("known Project Ledger lifecycle tools use the project_ledger owner while custom names stay other_tool", () => {
  const checkpoints: Array<Record<string, unknown>> = [];
  const attribution = {
    checkpoint(input: Record<string, unknown>) {
      checkpoints.push(input);
    },
    projectLedgerPhase() {},
    terminal() {},
    close() {},
  };
  recordRuntimeMemoryEvent(attribution, {
    type: "tool_call",
    iteration: 1,
    toolCall: {
      id: "private-tool-call-id",
      name: "project_ledger_work_update",
      arguments: { id: "private-work-id", body: "private body" },
      rawArguments: "{\"id\":\"private-work-id\"}",
    },
  });
  recordRuntimeMemoryEvent(attribution, {
    type: "tool_call",
    iteration: 2,
    toolCall: {
      id: "private-custom-call-id",
      name: "project_ledger_custom_private_tool",
      arguments: { secret: "private" },
      rawArguments: "{\"secret\":\"private\"}",
    },
  });
  expect(checkpoints.map((checkpoint) => checkpoint.operation)).toEqual([
    "project_ledger",
    "other_tool",
  ]);
  expect(JSON.stringify(checkpoints)).not.toContain("private-work-id");
  expect(JSON.stringify(checkpoints)).not.toContain("private body");
});

test("rotation retains only current and previous bounded segments", () => {
  const root = tempRoot("agent-memory-attribution-rotation");
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: { BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1" },
      maxSegmentBytes: 700,
      maxEvents: 20,
      processMemoryUsage: fixedCounters,
      heapStats: () => ({}),
    });
    for (let index = 0; index < 20; index += 1) {
      port.checkpoint({ event: "model_call_start", operation: "provider", iteration: index });
    }
    port.close();

    const diagnostics = join(root, "diagnostics");
    const current = join(diagnostics, "agent-memory-attribution.jsonl");
    const previous = join(diagnostics, "agent-memory-attribution.previous.jsonl");
    expect(existsSync(current)).toBe(true);
    expect(existsSync(previous)).toBe(true);
    expect(statSync(current).size).toBeLessThanOrEqual(700);
    expect(statSync(previous).size).toBeLessThanOrEqual(700);
    expect(lines(root).length + lines(root, "agent-memory-attribution.previous.jsonl").length)
      .toBeLessThanOrEqual(20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing corrupt tail is rotated without being read into the new segment", () => {
  const root = tempRoot("agent-memory-attribution-corrupt");
  const diagnostics = join(root, "diagnostics");
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const current = join(diagnostics, "agent-memory-attribution.jsonl");
  writeFileSync(current, "corrupt-private-tail\n", { mode: 0o600 });
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: { BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1" },
      processMemoryUsage: fixedCounters,
      heapStats: () => ({}),
    });
    port.checkpoint({ event: "turn_start", operation: "turn" });
    port.close();
    expect(lines(root)).toHaveLength(1);
    expect(readFileSync(join(diagnostics, "agent-memory-attribution.previous.jsonl"), "utf8"))
      .toContain("corrupt-private-tail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated GC requires the marker and waits until the last overlapping Turn is idle", async () => {
  const root = tempRoot("agent-memory-attribution-gc");
  const diagnostics = join(root, "diagnostics");
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const marker = join(diagnostics, "allow-isolated-gc-probe");
  writeFileSync(marker, "isolated\n", { mode: 0o600 });
  chmodSync(marker, 0o600);
  let gcCalls = 0;
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: {
        BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1",
        BUTLER_AGENT_MEMORY_DIAGNOSTICS_GC_PROBE: "1",
      },
      idleDelayMs: 5,
      processMemoryUsage: fixedCounters,
      heapStats: () => ({}),
      gc: () => { gcCalls += 1; },
    });
    port.checkpoint({ event: "turn_start", operation: "turn" });
    port.checkpoint({ event: "turn_start", operation: "turn" });
    port.terminal("delivered");
    port.checkpoint({ event: "turn_end", operation: "turn" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(gcCalls).toBe(0);

    port.terminal("delivered");
    port.checkpoint({ event: "turn_end", operation: "turn" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(gcCalls).toBe(1);
    const recordedEvents = [
      ...lines(root),
      ...lines(root, "agent-memory-attribution.previous.jsonl"),
    ].map((record) => record.event);
    expect(recordedEvents).toContain("idle_pre_gc");
    expect(recordedEvents).toContain("idle_post_gc");
    port.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC probe stays disabled without the mode-0600 isolated marker and close cancels idle work", async () => {
  const root = tempRoot("agent-memory-attribution-gc-gate");
  const diagnostics = join(root, "diagnostics");
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const marker = join(diagnostics, "allow-isolated-gc-probe");
  writeFileSync(marker, "wrong-mode\n", { mode: 0o644 });
  let gcCalls = 0;
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: {
        BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1",
        BUTLER_AGENT_MEMORY_DIAGNOSTICS_GC_PROBE: "1",
      },
      idleDelayMs: 5,
      processMemoryUsage: fixedCounters,
      heapStats: () => ({}),
      gc: () => { gcCalls += 1; },
    });
    port.checkpoint({ event: "turn_start", operation: "turn" });
    port.terminal("delivered");
    port.checkpoint({ event: "turn_end", operation: "turn" });
    port.close();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(gcCalls).toBe(0);
    expect(lines(root).some((record) => record.event === "idle_pre_gc")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counter failures are swallowed and do not reject the caller", () => {
  const root = tempRoot("agent-memory-attribution-failure");
  try {
    const port = createRuntimeMemoryAttributionPort({
      butlerData: root,
      env: { BUTLER_AGENT_MEMORY_DIAGNOSTICS: "1" },
      processMemoryUsage: () => { throw new Error("private counter failure"); },
      heapStats: () => ({}),
    });
    expect(() => port.checkpoint({ event: "turn_start", operation: "turn" })).not.toThrow();
    expect(() => port.terminal("cancelled")).not.toThrow();
    expect(() => port.close()).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
