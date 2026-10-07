import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = process.cwd();
const validator = join(root, "tools", "validation", "validate.ts");

function tempRoot(): string {
  const dir = join(tmpdir(), `silent-validation-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("silent mode (default) produces no output on successful validation", () => {
  const tempDir = tempRoot();

  try {
    // Create a mock package.json with a simple passing gate
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "pass-gate": "exit 0",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "pass-gate"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("silent mode prints bounded failure output with gate name, exit code, and tail", () => {
  const tempDir = tempRoot();

  try {
    // Create a mock package.json with a failing gate
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "fail-gate": "echo 'some output' && echo 'error output' >&2 && exit 1",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "fail-gate"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Validation gate failed: fail-gate");
    expect(result.stderr).toContain("Exit code:");
    expect(result.stderr).toContain("Timeout: no");
    expect(result.stderr).toContain("Duration:");
    expect(result.stderr).toContain("Stderr (tail):");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test("JSON mode includes tail and truncation flags on failure", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "fail-gate": "echo 'stdout content' && echo 'stderr content' >&2 && exit 1",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "fail-gate", "--json"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.gate).toBe("fail-gate");
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.timedOut).toBe(false);
    expect(parsed.stderrLength).toBeGreaterThan(0);
    expect(parsed.stderrTail.length).toBeGreaterThan(0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test("timeout terminates descendants that keep validation pipes open", () => {
  const tempDir = tempRoot();

  try {
    const scriptPath = join(tempDir, "hold-open.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "trap '' TERM",
        "(trap '' TERM; while true; do echo descendant-output; sleep 1; done) &",
        "wait",
      ].join("\n"),
    );
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "timeout-gate": `bash ${scriptPath}`,
        },
      }),
    );

    const startedAt = Date.now();
    const result = spawnSync("bun", [validator, "timeout-gate", "--json", "--timeout=1"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
      timeout: 10_000,
    });
    const durationMs = Date.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(durationMs).toBeLessThan(10_000);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.gate).toBe("timeout-gate");
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.timedOut).toBe(true);
    expect(parsed.stdoutTail).toContain("descendant-output");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test("validator requires gate argument", () => {
  const result = spawnSync("bun", [validator], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: validate.ts <gate>");
  expect(result.stderr).toContain("Example: validate.ts check");
});
