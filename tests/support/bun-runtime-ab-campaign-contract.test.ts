import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCampaignEvidence } from "./bun-runtime-ab-cli.ts";
import {
  computeSourceFingerprint,
  digestRuntimeCacheResource,
  modelCacheCandidates,
  portableGuardIdentity,
} from "../e2e/btcc-r3-electron/packaged-memory-campaign-evidence.ts";

describe("Bun campaign evidence contract", () => {
  test("requires structured exact attempt/success counts", () => {
    const archive = {
      schema: "butler.archive-stream-guard.v1",
      ok: true,
      attempts: 10,
      successes: 10,
      commandLabel: "electron+1args",
      commandFingerprint: "command-hash",
      executableLabel: "bun",
      executableFingerprint: "executable-hash",
      bunVersion: "1.3.11",
    };
    expect(validateCampaignEvidence(archive, 10, archive.schema, "1.3.11").ok).toBe(true);
    expect(validateCampaignEvidence({ ...archive, successes: 9 }, 10, archive.schema, "1.3.11").ok).toBe(false);
    expect(validateCampaignEvidence({ ...archive, attempts: 23, successes: 23 }, 10, archive.schema, "1.3.11").ok).toBe(false);
    expect(validateCampaignEvidence({
      schema: "butler.bun-packaging-guard.v1",
      ok: true,
      attempts: 23,
      successes: 23,
      commandLabel: "bun+1args",
      commandFingerprint: "command-hash",
      executableLabel: "bun",
      executableFingerprint: "executable-hash",
      bunVersion: "1.3.11",
    }, 23, "butler.bun-packaging-guard.v1", "1.3.11").ok).toBe(true);
    expect(validateCampaignEvidence({
      schema: "butler.bun-packaging-guard.v1",
      ok: true,
      attempts: 23,
      successes: 23,
    }, 23, "butler.bun-packaging-guard.v1", "1.3.11").ok).toBe(false);
    expect(validateCampaignEvidence({ ...archive, bunVersion: "1.3.14" }, 10, archive.schema, "1.3.11").ok).toBe(false);
    expect(validateCampaignEvidence({ ...archive, schema: "wrong" }, 10, archive.schema, "1.3.11").ok).toBe(false);
    expect(validateCampaignEvidence({
      ...archive,
      executableLabel: "/private/worktree/bun",
      commandLabel: "/private/worktree/archive --secret",
    }, 10, archive.schema, "1.3.11").ok).toBe(true);
  });

  test("includes untracked production sources and excludes only the Bun binary from cache identity", () => {
    const root = mkdtempSync(join(tmpdir(), "butler-rmf-fingerprint-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "rmf@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "RMF Test"], { cwd: root });
      writeFileSync(join(root, "tracked.txt"), "tracked\n", "utf8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
      const before = computeSourceFingerprint(root);
      mkdirSync(join(root, "packages", "production"), { recursive: true });
      writeFileSync(join(root, "packages", "production", "new-source.ts"), "export const value = 1;\n", "utf8");
      const after = computeSourceFingerprint(root);
      expect(before.fingerprint).not.toBe(after.fingerprint);

      const runtime = join(root, "runtime");
      mkdirSync(join(runtime, "bin"), { recursive: true });
      writeFileSync(join(runtime, "bin", "bun"), "pinned", "utf8");
      writeFileSync(join(runtime, "payload.bin"), "same", "utf8");
      const cacheBefore = digestRuntimeCacheResource(runtime);
      writeFileSync(join(runtime, "bin", "bun"), "candidate", "utf8");
      expect(digestRuntimeCacheResource(runtime)).toBe(cacheBefore);
      writeFileSync(join(runtime, "payload.bin"), "changed", "utf8");
      expect(digestRuntimeCacheResource(runtime)).not.toBe(cacheBefore);

      const managedExecutable = join(
        root,
        "app",
        "runtime",
        "agent",
        "versions",
        "fixture",
        "packages",
        "butler-agent",
        "resources",
        "runtime",
        "bin",
        "bun",
      );
      expect(modelCacheCandidates(managedExecutable)).toEqual([
        join(root, "app", "runtime", "agent", "versions", "fixture", "node_modules", "@huggingface", "transformers", ".cache"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("portable guard identity never serializes executable paths or command arguments", () => {
    const identity = portableGuardIdentity({
      bunExecutable: "/Users/private/worktree/.bun/bin/bun",
      command: ["/Users/private/electron", "--profile", "/Users/private/run-root"],
    });
    const serialized = JSON.stringify(identity);
    expect(serialized).toContain("bun");
    expect(serialized).toContain("electron+2args");
    expect(serialized).not.toContain("/Users/private");
    expect(serialized).not.toContain("run-root");
  });
});
