import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentBenchmarkCli } from
  "../../support/agent-benchmark/cli.ts";
import type { BenchmarkPlan, BenchmarkResultFile } from
  "../../support/agent-benchmark/contracts.ts";
import type { PreparedButlerResourceReference } from
  "../../support/agent-benchmark/prepared-butler-resource.ts";
import { prepareTestHarnessAuthority } from
  "../../unit/support/m1-v2-provenance-authority.ts";

test("canonical CLI hands a missing prepared resource to the production adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-prepared-cli-"));
  try {
    const authority = prepareTestHarnessAuthority(root);
    const sourceRoot = join(root, "source");
    execFileSync("git", [
      "-c", "advice.detachedHead=false", "clone", "--quiet", "--local",
      process.cwd(), sourceRoot,
    ]);
    const sourceRevision = execFileSync(
      "git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" },
    ).trim();
    const runRoot = join(root, "run");
    const pinPath = join(root, "prepared-resource-pin.json");
    const pin: PreparedButlerResourceReference = {
      resourceDir: join(root, "missing-resource"),
      sourceRevision,
      sourceCompatibilitySha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      dependencyClosureSha256: "3".repeat(64),
      resourceSha256: "4".repeat(64),
      resourceBytes: 1,
      archiveSha256: "5".repeat(64),
      archiveBytes: 1,
    };
    writeFileSync(pinPath, `${JSON.stringify(pin)}\n`, "utf8");
    const args = cliArgs(runRoot, sourceRoot, authority, sourceRevision, pinPath);

    const output = JSON.parse(await runAgentBenchmarkCli(args)) as { gates: number };
    expect(output.gates).toBe(1);
    const result = JSON.parse(readFileSync(join(runRoot, "result.json"), "utf8")) as
      BenchmarkResultFile;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      gateCode: "measurement_unavailable",
      terminalState: "gated",
    });
    expect(result.observations[0]!.diagnostics.join("\n")).toContain(
      "prepared_resource_missing",
    );
    const manifest = JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8")) as
      BenchmarkPlan;
    expect(manifest.preparedButlerResource).toEqual({
      sourceRevision: pin.sourceRevision,
      sourceCompatibilitySha256: pin.sourceCompatibilitySha256,
      manifestSha256: pin.manifestSha256,
      dependencyClosureSha256: pin.dependencyClosureSha256,
      resourceSha256: pin.resourceSha256,
      resourceBytes: pin.resourceBytes,
      archiveSha256: pin.archiveSha256,
      archiveBytes: pin.archiveBytes,
    });
    expect(JSON.stringify(manifest.preparedButlerResource)).not.toContain(root);
    expect(JSON.stringify(manifest.preparedButlerResource)).not.toContain("resourceDir");

    writeFileSync(pinPath, `${JSON.stringify({
      ...pin,
      sourceCompatibilitySha256: "f".repeat(64),
    })}\n`, "utf8");
    await expect(runAgentBenchmarkCli(args)).rejects.toThrow("manifest identity mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function cliArgs(
  runRoot: string,
  sourceRoot: string,
  authority: ReturnType<typeof prepareTestHarnessAuthority>,
  sourceRevision: string,
  pinPath: string,
): string[] {
  return [
    "run", "--campaign", "m1-v2", "--seed", "1",
    "--run-id", "prepared-cli-handoff", "--run-root", runRoot,
    "--source-root", sourceRoot, "--output", join(runRoot, "report"),
    "--harness-root", authority.harnessRoot,
    "--provenance-jsonl", authority.jsonlPath,
    "--controlled-model", "openai/gpt-5.6-sol",
    "--controlled-reasoning", "medium", "--source-revision", sourceRevision,
    "--repetitions", "3", "--prepared-butler-resource-pin", pinPath,
  ];
}
