import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BtccRevision } from
  "../support/btcc-revision-benchmark/contracts.ts";
import {
  buildBenchmarkTargets,
  type BenchmarkTargetBeforeBuild,
  type TargetCommandRunner,
  uiDistBuildId,
  verifyBenchmarkTargets,
} from "../support/btcc-revision-benchmark/target-build.ts";

describe("BTCC revision benchmark target builds", () => {
  test("builds each clean target and binds the plan to its UI dist digest", () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-target-build-"));
    const roots = {
      r2: join(root, "r2"),
      r3: join(root, "r3"),
    };
    mkdirSync(roots.r2, { recursive: true });
    mkdirSync(roots.r3, { recursive: true });
    const targets = {
      r2: target("r2", roots.r2),
      r3: target("r3", roots.r3),
    };
    const builds: string[] = [];
    const command = commandRunner(targets, builds);

    try {
      const built = buildBenchmarkTargets(targets, command);

      expect(builds).toEqual([roots.r2, roots.r3]);
      expect(built.r2.buildId).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(built.r3.buildId).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(built.r2.buildId).toBe(uiDistBuildId(roots.r2));
      expect(built.r3.buildId).toBe(uiDistBuildId(roots.r3));
      expect(() => verifyBenchmarkTargets(built, command)).not.toThrow();

      const invalidBuildId = {
        ...built,
        r2: { ...built.r2, buildId: "r2-manual-label" },
      };
      expect(() => verifyBenchmarkTargets(invalidBuildId, command)).toThrow(
        "Benchmark r2 buildId must be sha256:<digest>",
      );

      const wrongHead: TargetCommandRunner = (executable, args, cwd) => {
        if (
          executable === "git" &&
          args[0] === "rev-parse" &&
          cwd === roots.r2
        ) return `${"0".repeat(40)}\n`;
        return command(executable, args, cwd);
      };
      expect(() => verifyBenchmarkTargets(built, wrongHead)).toThrow(
        "Benchmark r2 checkout is 0000000000000000000000000000000000000000",
      );

      const r2Index = join(roots.r2, "packages/butler-app/client/ui/dist/index.html");
      writeFileSync(r2Index, "changed after plan creation\n", "utf8");
      expect(() => verifyBenchmarkTargets(built, command)).toThrow(
        "Benchmark r2 UI build is sha256:",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a dirty checkout before trusting its dist", () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-target-dirty-"));
    const targets = {
      r2: target("r2", join(root, "r2")),
      r3: target("r3", join(root, "r3")),
    };
    mkdirSync(targets.r2.worktreePath, { recursive: true });
    mkdirSync(targets.r3.worktreePath, { recursive: true });
    const clean = commandRunner(targets, []);
    const dirty: TargetCommandRunner = (executable, args, cwd) => {
      if (
        executable === "git" &&
        args[0] === "status" &&
        cwd === targets.r2.worktreePath
      ) return " M packages/butler-app/client/ui/src/App.tsx\n";
      return clean(executable, args, cwd);
    };

    try {
      expect(() => buildBenchmarkTargets(targets, dirty)).toThrow(
        "Benchmark r2 checkout is not clean",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function target(
  revision: BtccRevision,
  worktreePath: string,
): BenchmarkTargetBeforeBuild {
  return {
    revision,
    worktreePath,
    commit: revision === "r2" ? "2".repeat(40) : "3".repeat(40),
    appBaseUrl: `http://127.0.0.1:${revision === "r2" ? 28765 : 28766}`,
    electronDebugPort: revision === "r2" ? 29765 : 29766,
    dataRoot: join(worktreePath, "data"),
    electronUserData: join(worktreePath, "electron"),
    workspaceRoot: join(worktreePath, "workspace"),
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "low",
    permissionMode: "full_access",
    fixtureHash: "fixture-v1",
  };
}

function commandRunner(
  targets: Record<BtccRevision, BenchmarkTargetBeforeBuild>,
  builds: string[],
): TargetCommandRunner {
  const targetByRoot = new Map<string, BenchmarkTargetBeforeBuild>([
    [targets.r2.worktreePath, targets.r2],
    [targets.r3.worktreePath, targets.r3],
  ]);
  return (executable, args, cwd) => {
    const current = targetByRoot.get(cwd);
    if (!current) throw new Error(`Unexpected target: ${cwd}`);
    if (executable === "git" && args[0] === "rev-parse") {
      return `${current.commit}\n`;
    }
    if (executable === "git" && args[0] === "status") return "";
    if (args[0] === "run" && args[1] === "app:ui:build") {
      builds.push(cwd);
      const dist = join(cwd, "packages/butler-app/client/ui/dist");
      mkdirSync(join(dist, "assets"), { recursive: true });
      writeFileSync(
        join(dist, "index.html"),
        `<main>${current.revision}</main>\n`,
        "utf8",
      );
      writeFileSync(
        join(dist, "assets", "app.js"),
        `console.log(${JSON.stringify(current.revision)});\n`,
        "utf8",
      );
      return "built\n";
    }
    throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
  };
}
