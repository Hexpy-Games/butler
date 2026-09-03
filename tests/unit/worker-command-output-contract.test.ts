import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { executeGuidedReadOnlyCommand } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-read-only-command.ts";
import { budgetToolOutput, readToolOutputArtifact, type FocusedToolOutputArtifactRead } from "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";
import { estimateContextTokens } from "../../packages/butler-agent/src/agent/context/budget.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function commandFixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-command-output-"));
  roots.push(root);
  const execute = createButlerToolExecutor({ butlerHome: root, butlerData: root, workspacePath: root });
  return {
    root,
    async native(args: Record<string, unknown>) {
      return await execute({ name: "run_command", args, rawArguments: "{}" }) as Record<string, any>;
    },
    async guided(args: Record<string, unknown>) {
      return await executeGuidedReadOnlyCommand({ args, butlerData: root, workspacePath: root, originalRequest: "inspect command output" });
    },
    async read(args: Record<string, unknown>) {
      return await execute({ name: "read_tool_output_artifact", args, rawArguments: "{}" }) as FocusedToolOutputArtifactRead;
    },
  };
}

test("native and guided previews retain the same real failure output for search and exact continuation", async () => {
  const fixture = commandFixture();
  const args = {
    command: "printf '  begin\\r\\n'; printf 'x%.0s' {1..2000}; printf ' MIDDLE_FAILURE '; printf 'y%.0s' {1..2000}; printf '\\r\\n  end  \\n'; printf 'stderr cause\\n' >&2; exit 7",
    output_mode: "auto",
  };
  const native = await fixture.native(args);
  const guided = await fixture.guided(args);
  expect(native).toMatchObject({ ok: false, exit_code: 7, output_presentation: { truncated: true, suppressed: false } });
  if (process.platform === "darwin") {
    expect(guided).toMatchObject({ ok: false, exit_code: 7, stdout: native.stdout, stderr: native.stderr, output_presentation: native.output_presentation });
  }
  for (const result of process.platform === "darwin" ? [native, guided] : [native]) {
    const artifact = result.butler_tool_artifact as { path: string };
    const saved = readToolOutputArtifact(artifact.path) as { result: { stdout: string; stderr: string } };
    expect(saved.result.stdout).toContain("MIDDLE_FAILURE");
    expect(saved.result.stderr).toBe("stderr cause\n");
    const match = await fixture.read({ path: artifact.path, stream: "stdout", search: "MIDDLE_FAILURE", max_tokens: 50 });
    expect(match.stdout?.search).toMatchObject({ found: true });
    expect(match.stdout?.text).toStartWith("MIDDLE_FAILURE");
    const absent = await fixture.read({ path: artifact.path, stream: "stdout", search: "ABSENT" });
    expect(absent.stdout?.search).toMatchObject({ found: false, match_char: null });
    let cursor: number | null = 0;
    let restored = "";
    while (cursor !== null) {
      const slice = await fixture.read({ path: artifact.path, stream: "stdout", offset_chars: cursor, max_tokens: 50, limit_lines: 1 });
      expect(slice.stdout?.start_char).toBe(cursor);
      restored += slice.stdout!.text;
      const next = slice.stdout!.next_offset_chars;
      if (next !== null) expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(restored).toBe(saved.result.stdout);
  }
});

test("silent success saves original streams and full reports requested versus applied limits", async () => {
  const fixture = commandFixture();
  for (const execute of process.platform === "darwin" ? [fixture.native, fixture.guided] : [fixture.native]) {
    const silent = await execute({ command: "printf original; printf warning >&2", output_mode: "silent_on_success" });
    expect(silent).toMatchObject({ ok: true, stdout: "", stderr: "", output_presentation: { suppressed: true } });
    const artifact = silent.butler_tool_artifact as { path: string };
    expect(await fixture.read({ path: artifact.path })).toMatchObject({ stdout: { text: "original" }, stderr: { text: "warning" } });
    const full = await execute({ command: "printf 'long-line-%.0s' {1..6000}", output_mode: "full", max_output_tokens: 30_000 });
    expect(full).toMatchObject({ ok: true, output_presentation: { mode: "full", requested_max_tokens: 30_000, applied_max_tokens: 8_000, truncated: true } });
    const read = await fixture.read({ path: (full.butler_tool_artifact as { path: string }).path, max_tokens: 30_000 });
    expect(read.limits).toMatchObject({ requested_max_tokens: 30_000, applied_max_tokens: 8_000 });
    expect(read.stdout?.next_offset_chars).toBeGreaterThan(0);
    expect(read.stdout?.truncated_by_tokens).toBe(true);
  }
});

test("validation metadata never changes pipeline execution status", async () => {
  const fixture = commandFixture();
  const command = "false | cat";
  const unlabeled = await fixture.native({ command });
  const labeled = await fixture.native({ command, validation_suite: "diagnostic" });
  expect(labeled.exit_code).toBe(unlabeled.exit_code);
  expect(labeled.ok).toBe(unlabeled.ok);
});

test("native missing declared outputs are reported separately from command success", async () => {
  const fixture = commandFixture();
  const result = await fixture.native({ command: "printf success", output_paths: ["missing.txt"] });
  expect(result).toMatchObject({
    ok: true, exit_code: 0, stdout: "success",
    artifact_publication: { ok: false, requested: 1, published: 0, unpublished: 1, error: { code: "declared_output_files_unavailable" } },
  });
  expect(result).not.toHaveProperty("error");
});

test("guided publication filesystem errors preserve the completed command outcome", async () => {
  const fixture = commandFixture();
  mkdirSync(join(fixture.root, "artifacts"));
  writeFileSync(join(fixture.root, "artifacts", "generated"), "not a directory");
  const result = await fixture.guided({ command: "printf success", output_paths: ["missing.txt"] });
  if (process.platform !== "darwin") return;
  expect(result).toMatchObject({
    ok: true, exit_code: 0, timed_out: false, stdout: "success",
    artifact_publication: { ok: false, requested: 1, published: 0, error: { code: "artifact_publication_failed" } },
  });
  expect(result).not.toHaveProperty("error");
  const failure = await fixture.guided({ command: "printf cause >&2; exit 7", output_paths: ["missing.txt"] });
  expect(failure).toMatchObject({ ok: false, exit_code: 7, stderr: "cause" });
  expect(failure).not.toHaveProperty("artifact_publication");
});

test("CJK previews including notices fit the reported estimator budget and preserve raw output", () => {
  const fixture = commandFixture();
  const raw = { stdout: "가나다라마바사 漢字 ".repeat(80), stderr: "실패원인 中文 ".repeat(40), exit_code: 2, timed_out: false };
  for (const outputMode of ["full", "auto"]) {
    const result = budgetToolOutput({ result: raw, outputMode, butlerData: join(fixture.root, "long-path-".repeat(20)), maxModelTokens: 200 });
    const visible = [`stdout:\n${result.stdout}`, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n\n");
    expect(estimateContextTokens(visible)).toBeLessThanOrEqual(200);
    expect(result.butler_tool_artifact?.compact_tokens).toBeLessThanOrEqual(200);
    expect(readToolOutputArtifact(result.butler_tool_artifact!.path)?.result).toEqual(raw);
  }
});
