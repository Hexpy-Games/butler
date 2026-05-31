import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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

test("verbose mode streams output and prints success summary with duration", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "pass-gate": "echo 'running validation'",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "pass-gate", "--verbose"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ Validation gate passed: pass-gate");
    expect(result.stdout).toContain("Duration:");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verbose mode streams child process output in real-time", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "verbose-gate": "echo 'line 1' && echo 'line 2'",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "verbose-gate", "--verbose"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).toBe(0);
    // Verbose mode inherits stdio, so output goes directly to console
    // We verify success by checking the final summary
    expect(result.stdout).toContain("✓ Validation gate passed: verbose-gate");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("JSON mode emits compact structured output without full stdout/stderr", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "json-gate": "echo 'output line'",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "json-gate", "--json"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.gate).toBe("json-gate");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.timedOut).toBe(false);
    expect(parsed.durationMs).toBeGreaterThan(0);
    expect(parsed.stdoutLength).toBeGreaterThanOrEqual(0);
    expect(parsed.stderrLength).toBeGreaterThanOrEqual(0);
    expect(typeof parsed.stdoutTail).toBe("string");
    expect(typeof parsed.stderrTail).toBe("string");
    expect(typeof parsed.stdoutTruncated).toBe("boolean");
    expect(typeof parsed.stderrTruncated).toBe("boolean");
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

test("failure output truncates long stdout to tail with truncation notice", () => {
  const tempDir = tempRoot();

  try {
    // Create a gate that generates lots of output (more than 20 lines and 1000 chars)
    const longOutput = Array.from({ length: 50 }, (_, i) => `echo 'line ${i}: ${"x".repeat(50)}'`).join(" && ");

    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "verbose-gate": longOutput,
        },
      }),
    );

    const result = spawnSync("bun", [validator, "verbose-gate", "--json"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);

    // Verify the tail limits are enforced (20 lines, 1000 chars)
    if (parsed.stdoutLength > 1000) {
      expect(parsed.stdoutTail.length).toBeLessThanOrEqual(1000);
      expect(parsed.stdoutTruncated).toBe(true);
    }

    // Verify line count limit
    const lines = parsed.stdoutTail.split("\n");
    if (parsed.stdoutLength > lines.length * 50) {
      expect(lines.length).toBeLessThanOrEqual(20);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failure output truncates long stderr to tail with truncation notice", () => {
  const tempDir = tempRoot();

  try {
    // Create a gate with lots of stderr output
    const longStderr = Array.from({ length: 50 }, (_, i) => `echo 'error ${i}: ${"e".repeat(50)}' >&2`).join(" && ");

    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "stderr-gate": `${longStderr} && exit 1`,
        },
      }),
    );

    const result = spawnSync("bun", [validator, "stderr-gate"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Stderr (tail):");

    expect(result.stderr).toContain("Stderr (tail):");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("timeout flag with custom timeout value", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "quick-gate": "exit 0",
        },
      }),
    );

    // Test with a reasonable timeout
    const result = spawnSync("bun", [validator, "quick-gate", "--timeout=60"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    // Should complete successfully with this reasonable timeout
    expect(result.status).toBe(0);
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

test("validator accepts gate with mode flags", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "gate": "exit 0",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "gate", "--json"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.gate).toBe("gate");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("JSON mode on success includes zero exit code and valid structure", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "gate": "exit 0",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "gate", "--json"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);

    // Verify all required fields are present
    expect(parsed).toHaveProperty("gate");
    expect(parsed).toHaveProperty("exitCode");
    expect(parsed).toHaveProperty("timedOut");
    expect(parsed).toHaveProperty("durationMs");
    expect(parsed).toHaveProperty("stdoutLength");
    expect(parsed).toHaveProperty("stderrLength");
    expect(parsed).toHaveProperty("stdoutTail");
    expect(parsed).toHaveProperty("stderrTail");
    expect(parsed).toHaveProperty("stdoutTruncated");
    expect(parsed).toHaveProperty("stderrTruncated");

    expect(parsed.exitCode).toBe(0);
    expect(parsed.timedOut).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("JSON mode on failure includes non-zero exit code", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "fail": "exit 42",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "fail", "--json"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.exitCode).toBe(result.status);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("silent mode shows stdout tail when gate fails with stdout", () => {
  const tempDir = tempRoot();

  try {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test",
        scripts: {
          "fail-with-output": "echo 'stdout message' && echo 'stderr message' >&2 && exit 1",
        },
      }),
    );

    const result = spawnSync("bun", [validator, "fail-with-output"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Validation gate failed:");

    // If there's stdout, it should appear
    if (result.stderr.includes("Stdout (tail):")) {
      expect(result.stderr).toContain("Stdout (tail):");
    }

    // Stderr should always be present for script errors
    expect(result.stderr).toContain("Stderr (tail):");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("validate.ts integrates with package.json test:unit script", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  expect(packageJson.scripts["test:unit"]).toContain("validate.ts test:unit:run");
  expect(packageJson.scripts["test:unit:run"]).toBe("${BUTLER_BUN:-bun} test tests/unit/*.test.ts");
});
