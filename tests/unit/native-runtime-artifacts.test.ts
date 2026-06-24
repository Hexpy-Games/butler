import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { runtimeArtifactsFromAudit } from "../../packages/butler-agent/src/agent/turn/native/output/runtime-artifacts.ts";
import type { ToolAuditEntry } from "../../packages/butler-agent/src/agent/turn/native/output/tool-types.ts";

test("runtime artifact projection resolves verified output files under workspace", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "butler-runtime-artifact-workspace-"));
  const butlerData = mkdtempSync(join(tmpdir(), "butler-runtime-artifact-data-"));
  const csvPath = join(workspacePath, "report.csv");
  writeFileSync(csvPath, "city,count\nseoul,1\n");

  const artifacts = runtimeArtifactsFromAudit({
    butlerData,
    workspacePath,
    audit: [successfulTool({
      cwd: workspacePath,
      verified_output_files: [{
        path: "report.csv",
        artifact_kind: "csv_file",
        modified_at: "2026-06-23T10:10:00.000Z",
      }],
    })],
  });

  expect(artifacts).toEqual([expect.objectContaining({
    kind: "csv_file",
    title: "report.csv",
    safePathLabel: "report.csv",
    localPath: csvPath,
    mimeType: "text/csv",
    sizeBytes: 19,
    createdAt: "2026-06-23T10:10:00.000Z",
  })]);
});

test("runtime artifact projection resolves public data artifacts and de-duplicates paths", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "butler-runtime-artifact-workspace-"));
  const butlerData = mkdtempSync(join(tmpdir(), "butler-runtime-artifact-data-"));
  const publicDataRoot = join(butlerData, "artifacts", "public-data", "charts");
  mkdirSync(publicDataRoot, { recursive: true });
  const chartPath = join(publicDataRoot, "population.png");
  writeFileSync(chartPath, "png-bytes");

  const artifacts = runtimeArtifactsFromAudit({
    butlerData,
    workspacePath,
    audit: [
      successfulTool({
        artifact_id: "population-chart",
        artifact_labels: ["charts/population.png"],
        artifact_kinds: ["chart_file"],
        title: "Population chart",
      }),
      successfulTool({
        artifact_id: "population-chart-duplicate",
        artifact_labels: ["charts/population.png"],
        artifact_kinds: ["image"],
      }),
    ],
  });

  expect(artifacts).toEqual([{
    id: "population-chart",
    kind: "chart_file",
    title: "Population chart",
    safePathLabel: "charts/population.png",
    localPath: chartPath,
    mimeType: "image/png",
    sizeBytes: 9,
  }]);
});

test("runtime artifact projection rejects verified paths outside the workspace", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "butler-runtime-artifact-workspace-"));
  const butlerData = mkdtempSync(join(tmpdir(), "butler-runtime-artifact-data-"));
  writeFileSync(resolve(workspacePath, "..", "secret.csv"), "secret");

  const artifacts = runtimeArtifactsFromAudit({
    butlerData,
    workspacePath,
    audit: [successfulTool({
      cwd: workspacePath,
      verified_output_files: [{
        path: "../secret.csv",
        artifact_kind: "csv_file",
      }],
    })],
  });

  expect(artifacts).toEqual([]);
});

function successfulTool(result: Record<string, unknown>): ToolAuditEntry {
  return {
    name: "run_command",
    args: {},
    ok: true,
    result,
  };
}
