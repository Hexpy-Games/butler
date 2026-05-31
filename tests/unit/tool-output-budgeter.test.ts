import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  budgetToolOutput,
  pruneToolOutputArtifacts,
  readToolOutputArtifact,
  readToolOutputArtifactSlice,
  readToolOutputPruneMetrics,
} from "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";
import { estimateContextTokens } from "../../packages/butler-agent/src/agent/context/budget.ts";

test("tool output budgeter stores raw output and returns compact model view", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-tool-output-"));
  try {
    const result = budgetToolOutput({
      butlerData: root,
      command: "printf lots",
      cwd: root,
      maxModelTokens: 200,
      now: new Date("2026-04-27T00:00:00.000Z"),
      result: {
        stdout: Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(80)}`).join("\n"),
        stderr: "warning ".repeat(200),
        exit_code: 2,
        timed_out: false,
      },
    });

    expect(result.exit_code).toBe(2);
    expect(result.butler_tool_artifact).toBeDefined();
    expect(result.stdout).toContain("Artifact ID");
    expect(result.stdout).toContain("stdout preview");
    expect(estimateContextTokens(`${result.stdout}\n${result.stderr}`)).toBeLessThan(
      result.butler_tool_artifact!.raw_tokens,
    );

    const artifact = readToolOutputArtifact(result.butler_tool_artifact!.path);
    expect(artifact?.schema).toBe("butler.tool-output.v1");
    expect(JSON.stringify(artifact)).toContain("line 199");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool output budgeter passes through small outputs without artifact churn", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-tool-output-small-"));
  try {
    const result = budgetToolOutput({
      butlerData: root,
      maxModelTokens: 200,
      result: {
        stdout: "small",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      },
    });

    expect(result).toEqual({
      stdout: "small",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool output artifact pruning protects active artifact paths", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-tool-prune-"));
  try {
    const artifactsDir = join(root, "artifacts", "tool-output", "2026-04-26");
    const oldDelete = join(artifactsDir, "old-delete.json");
    const oldKeep = join(artifactsDir, "old-keep.json");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(oldDelete, "delete", "utf8");
    writeFileSync(oldKeep, "keep", "utf8");

    const result = pruneToolOutputArtifacts({
      butlerData: root,
      maxAgeMs: 0,
      maxBytes: 0,
      protectedPaths: [oldKeep],
      now: new Date("2026-04-27T00:00:00.000Z"),
    });

    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(existsSync(oldDelete)).toBe(false);
    expect(existsSync(oldKeep)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool output artifact focused read resolves safe slices by id and path", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-tool-read-"));
  try {
    const result = budgetToolOutput({
      butlerData: root,
      command: "generate many lines",
      cwd: root,
      maxModelTokens: 200,
      now: new Date("2026-04-27T00:00:00.000Z"),
      result: {
        stdout: Array.from({ length: 40 }, (_, index) => `stdout line ${index} ${"x".repeat(20)}`).join("\n"),
        stderr: Array.from({ length: 12 }, (_, index) => `stderr line ${index}`).join("\n"),
        exit_code: 0,
        timed_out: false,
      },
    });
    const artifact = result.butler_tool_artifact!;

    const byId = readToolOutputArtifactSlice({
      butlerData: root,
      artifactId: artifact.id,
      stream: "stdout",
      offsetLines: 5,
      limitLines: 4,
      maxTokens: 80,
    });

    expect(byId).toMatchObject({
      ok: true,
      rawTextStored: false,
      artifact: {
        id: artifact.id,
        path: artifact.path,
      },
      stdout: {
        start_line: 5,
        returned_lines: 4,
        total_lines: 40,
      },
    });
    expect(byId.stdout?.text).toContain("stdout line 5");
    expect(byId.stdout?.text).not.toContain("stdout line 4");
    expect(byId.stderr).toBeUndefined();

    const byPath = readToolOutputArtifactSlice({
      butlerData: root,
      path: artifact.path,
      stream: "both",
      limitLines: 2,
      maxTokens: 60,
    });

    expect(byPath.ok).toBe(true);
    expect(byPath.stdout?.returned_lines).toBeGreaterThan(0);
    expect(byPath.stderr?.returned_lines).toBeGreaterThan(0);
    expect((byPath.stdout?.estimated_tokens ?? 0) + (byPath.stderr?.estimated_tokens ?? 0)).toBeLessThanOrEqual(60);

    const unsafe = readToolOutputArtifactSlice({
      butlerData: root,
      path: join(root, "outside.json"),
    });
    expect(unsafe).toMatchObject({
      ok: false,
      error: "unsafe_artifact_path",
      rawTextStored: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool output artifact read gives full token budget to the only populated stream", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-tool-read-single-stream-"));
  try {
    const result = budgetToolOutput({
      butlerData: root,
      command: "cat manifest",
      cwd: root,
      maxModelTokens: 100,
      now: new Date("2026-04-27T00:00:00.000Z"),
      result: {
        stdout: Array.from({ length: 80 }, (_, index) =>
          index === 60 ? "needle: app:client:workstream:live-llm:e2e" : `manifest line ${index}`,
        ).join("\n"),
        stderr: "",
        exit_code: 0,
        timed_out: false,
      },
    });

    const halfBudget = readToolOutputArtifactSlice({
      butlerData: root,
      artifactId: result.butler_tool_artifact!.id,
      stream: "both",
      limitLines: 80,
      maxTokens: 320,
    });

    expect(halfBudget.ok).toBe(true);
    expect(halfBudget.stderr?.text).toBe("");
    expect(halfBudget.stdout?.text).toContain("needle: app:client:workstream:live-llm:e2e");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool output artifact focused read rejects symlink escape and scan overflow", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-tool-read-safety-"));
  try {
    const artifactsDir = join(root, "artifacts", "tool-output", "2026-04-27");
    const outside = join(root, "outside-artifact.json");
    const symlinkPath = join(artifactsDir, "escape.json");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(outside, JSON.stringify({
      schema: "butler.tool-output.v1",
      id: "outside",
      result: {
        stdout: "SECRET_OUTSIDE_STDOUT",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      },
      raw_tokens: 4,
    }), "utf8");
    symlinkSync(outside, symlinkPath);

    const unsafe = readToolOutputArtifactSlice({
      butlerData: root,
      path: symlinkPath,
    });

    expect(unsafe).toMatchObject({
      ok: false,
      error: "unsafe_artifact_path",
      rawTextStored: false,
    });

    for (let index = 0; index < 3; index += 1) {
      writeFileSync(join(artifactsDir, `artifact-${index}.json`), JSON.stringify({
        schema: "butler.tool-output.v1",
        id: `artifact-${index}`,
        result: {
          stdout: `line ${index}`,
          stderr: "",
          exit_code: 0,
          timed_out: false,
        },
        raw_tokens: 4,
      }), "utf8");
    }

    const overflow = readToolOutputArtifactSlice({
      butlerData: root,
      artifactId: "artifact-2",
      maxArtifactScanFiles: 2,
    });
    expect(overflow).toMatchObject({
      ok: false,
      error: "artifact_scan_limit_exceeded",
      rawTextStored: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool output artifact pruning records raw-text-free maintenance telemetry", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-tool-prune-metric-"));
  try {
    const artifactsDir = join(root, "artifacts", "tool-output", "2026-04-26");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "old-delete.json"), "SECRET_RAW_STDOUT", "utf8");

    const result = pruneToolOutputArtifacts({
      butlerData: root,
      maxAgeMs: 0,
      maxBytes: 0,
      now: new Date("2026-04-27T00:00:00.000Z"),
      recordTelemetry: true,
    });

    expect(result).toMatchObject({
      scanned: 1,
      deleted: 1,
      rawTextStored: false,
      remainingBytes: 0,
    });
    const metrics = readToolOutputPruneMetrics(root);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      schema: "butler.tool-output-prune.v1",
      scanned: 1,
      deleted: 1,
      rawTextStored: false,
    });
    expect(JSON.stringify(metrics)).not.toContain("SECRET_RAW_STDOUT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
