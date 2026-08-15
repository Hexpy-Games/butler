import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeMemoryPhysicalObserver,
} from "../../packages/butler-agent/src/operations/diagnostics/runtime-memory-attribution/index.ts";

function root(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-${Date.now()}-`));
}

test("physical observer records macOS footprint and null unsupported counters without process identity", () => {
  const dataRoot = root("physical-observer-darwin");
  const output = join(dataRoot, "evidence", "physical.jsonl");
  try {
    const observer = createRuntimeMemoryPhysicalObserver({
      pid: 12345,
      outputPath: output,
      platform: "darwin",
      runtimeVersion: "1.3.11",
      clock: { monotonicMs: () => 4, wallClockMs: () => 8 },
      run: (command) => command === "ps"
        ? " 2048\n"
        : "Auxiliary data:\n    phys_footprint: 4096 B\n",
    });
    observer.sample("idle_checkpoint");
    observer.close();

    const record = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      schema: "butler.agent-memory-physical.v1",
      sequence: 0,
      monotonicMs: 4,
      wallClockMs: 8,
      role: "agent_runtime",
      event: "idle_checkpoint",
      runtimeVersion: "1.3.11",
      counters: {
        rssBytes: 2_097_152,
        physicalFootprintBytes: 4_096,
        privateResidentBytes: null,
        compressedBytes: null,
        swapBytes: null,
      },
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("12345");
    expect(serialized).not.toContain("--noCategories");
    expect(statSync(join(dataRoot, "evidence")).mode & 0o777).toBe(0o700);
    expect(statSync(output).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("physical observer reports Linux private resident and swap without pretending to support physical footprint", () => {
  const dataRoot = root("physical-observer-linux");
  const output = join(dataRoot, "physical.jsonl");
  try {
    const observer = createRuntimeMemoryPhysicalObserver({
      pid: 77,
      outputPath: output,
      platform: "linux",
      readFile: (path) => path.endsWith("smaps_rollup")
        ? "Rss: 100 kB\nPrivate_Clean: 20 kB\nPrivate_Dirty: 30 kB\n"
        : "VmSwap: 4 kB\n",
      run: () => " 512\n",
    });
    observer.sample("terminal_state");
    observer.close();
    const record = JSON.parse(readFileSync(output, "utf8")) as {
      counters: Record<string, unknown>;
    };
    expect(record.counters).toMatchObject({
      rssBytes: 524_288,
      physicalFootprintBytes: null,
      privateResidentBytes: 51_200,
      swapBytes: 4_096,
      compressedBytes: null,
    });
    expect(record.counters.unsupportedReasons).toMatchObject({
      physicalFootprintBytes: "linux_physical_footprint_unavailable",
      compressedBytes: "linux_compressed_counter_unavailable",
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("physical observer records typed Windows working set and private committed counters", () => {
  const dataRoot = root("physical-observer-windows");
  const output = join(dataRoot, "physical.jsonl");
  try {
    const observer = createRuntimeMemoryPhysicalObserver({
      pid: 88,
      outputPath: output,
      platform: "win32",
      run: (command) => command === "powershell.exe"
        ? "104857600\r\n73400320\r\n"
        : "",
    });
    observer.sample("idle_checkpoint");
    observer.close();
    const record = JSON.parse(readFileSync(output, "utf8")) as {
      counters: Record<string, unknown>;
    };
    expect(record.counters).toMatchObject({
      workingSetBytes: 104_857_600,
      privateCommittedBytes: 73_400_320,
      physicalFootprintBytes: null,
      privateResidentBytes: null,
    });
    expect(record.counters.unsupportedReasons).toMatchObject({
      physicalFootprintBytes: "platform_physical_footprint_unavailable",
      privateResidentBytes: "platform_private_resident_unavailable",
    });
    expect(JSON.stringify(record)).not.toContain("powershell.exe");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("physical observer failure is isolated and unsupported event labels are sanitized", () => {
  const dataRoot = root("physical-observer-failure");
  const output = join(dataRoot, "physical.jsonl");
  try {
    const observer = createRuntimeMemoryPhysicalObserver({
      pid: 1,
      outputPath: output,
      platform: "unknown" as NodeJS.Platform,
      run: () => { throw new Error("private command path"); },
      readFile: () => { throw new Error("private file path"); },
    });
    expect(() => observer.sample("private-event" as never)).not.toThrow();
    observer.close();
    expect(existsSync(output)).toBe(true);
    const record = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
    expect(record.event).toBe("other");
    expect(JSON.stringify(record)).not.toContain("private command path");
    expect(JSON.stringify(record)).not.toContain("private file path");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
