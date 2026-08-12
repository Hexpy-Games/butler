import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  preparedResourceIdentity,
  preparedResourceDirectoryIdentity,
  verifyPreparedButlerResource,
  withPreparedButlerResource,
} from "../../support/agent-benchmark/prepared-butler-resource.ts";
import { createBenchmarkPlan } from
  "../../support/agent-benchmark/planning.ts";
import { digest, preparedFixture } from "./prepared-resource-fixture.ts";

test("prepared resource pin verifies identity and remains immutable across sequential use", () => {
  const fixture = preparedFixture();
  try {
    const before = inventory(fixture.resourceDir);
    const first = verifyPreparedButlerResource(fixture.input);
    const second = verifyPreparedButlerResource(fixture.input);
    expect(first.identity).toEqual(second.identity);
    expect(inventory(fixture.resourceDir)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

test("prepared resource mismatches fail closed without exposing its path", () => {
  const fixture = preparedFixture();
  try {
    for (const [field, value, code] of [
      ["manifestSha256", "f".repeat(64), "prepared_resource_manifest_hash_mismatch"],
      ["dependencyClosureSha256", "f".repeat(64), "prepared_resource_dependency_closure_hash_mismatch"],
      ["archiveSha256", "f".repeat(64), "prepared_resource_manifest_identity_mismatch"],
      ["archiveBytes", fixture.reference.archiveBytes + 1, "prepared_resource_archive_size_mismatch"],
    ] as const) {
      let error: unknown;
      try {
        verifyPreparedButlerResource({
          ...fixture.input,
          reference: { ...fixture.reference, [field]: value },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain(fixture.root);
    }
  } finally {
    fixture.cleanup();
  }
});

test("resource shape, actual source revision, and manifest identity are enforced", () => {
  const fixture = preparedFixture();
  try {
    expect(() => verifyPreparedButlerResource({
      ...fixture.input,
      reference: {
        ...fixture.reference,
        resourceDir: join(fixture.resourceDir, "agent-release-manifest.json"),
      },
    })).toThrow("prepared_resource_unreadable");
    expect(() => verifyPreparedButlerResource({
      ...fixture.input,
      sourceRevision: "f".repeat(40),
    })).toThrow("prepared_resource_current_source_revision_mismatch");

    const manifestPath = join(fixture.resourceDir, "agent-release-manifest.json");
    const manifest = Buffer.from(`${JSON.stringify({
      artifacts: [{
        canonicalComponent: "agent",
        artifactName: "butler-agent-test.tar.gz",
        sha256: fixture.reference.archiveSha256,
        integrity: { digest: "f".repeat(64) },
      }],
    })}\n`);
    writeFileSync(manifestPath, manifest);
    expect(() => verifyPreparedButlerResource({
      ...fixture.input,
      reference: { ...fixture.reference, manifestSha256: digest(manifest) },
    })).toThrow("prepared_resource_manifest_provenance_invalid");
  } finally {
    fixture.cleanup();
  }
});

test("source-affecting mutation requires a new compatibility pin", () => {
  const fixture = preparedFixture();
  try {
    writeFileSync(join(fixture.sourceRoot, "VERSION"), "changed\n", "utf8");
    expect(() => verifyPreparedButlerResource(fixture.input)).toThrow(
      "prepared_resource_source_compatibility_mismatch_repin_required",
    );
  } finally {
    fixture.cleanup();
  }
});

test("source input special mode mutation requires a new compatibility pin", () => {
  const fixture = preparedFixture();
  try {
    execFileSync("chmod", ["4644", join(fixture.sourceRoot, "VERSION")]);
    expect(() => verifyPreparedButlerResource(fixture.input)).toThrow(
      "prepared_resource_source_compatibility_mismatch_repin_required",
    );
  } finally {
    fixture.cleanup();
  }
});

test("renderer build configuration and entry inputs require a new compatibility pin", () => {
  for (const path of ["index.html", "vite.config.ts", "tsconfig.json", "bun.lock"]) {
    const fixture = preparedFixture();
    try {
      writeFileSync(join(fixture.sourceRoot, "packages/butler-app/client/ui", path), "changed\n");
      expect(() => verifyPreparedButlerResource(fixture.input)).toThrow(
        "prepared_resource_source_compatibility_mismatch_repin_required",
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("app bundled-resource producer inputs require a new compatibility pin", () => {
  for (const path of [
    "packages/butler-app/client/electron/package.json",
    "packages/butler-app/scripts/background-service-contract.ts",
    "packages/butler-app/client/electron/windows-powershell-environment.mjs",
    "packages/butler-app/scripts/release/package-app-release.ts",
  ]) {
    const fixture = preparedFixture();
    try {
      writeFileSync(join(fixture.sourceRoot, path), "changed\n");
      expect(() => verifyPreparedButlerResource(fixture.input)).toThrow(
        "prepared_resource_source_compatibility_mismatch_repin_required",
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("a different current revision may reuse an input-compatible build resource", () => {
  const fixture = preparedFixture();
  try {
    const buildRevision = fixture.reference.sourceRevision;
    writeFileSync(join(fixture.sourceRoot, "non-packaging-note.txt"), "revision only\n");
    execFileSync("git", ["-C", fixture.sourceRoot, "add", "non-packaging-note.txt"]);
    execFileSync("git", [
      "-C", fixture.sourceRoot,
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-qm", "compatible revision",
    ]);
    const currentRevision = execFileSync(
      "git", ["-C", fixture.sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" },
    ).trim();
    expect(currentRevision).not.toBe(buildRevision);
    expect(verifyPreparedButlerResource({
      ...fixture.input,
      sourceRevision: currentRevision,
    }).identity.sourceRevision).toBe(buildRevision);
  } finally {
    fixture.cleanup();
  }
});

test("same-size archive mutation is rejected by content hash", () => {
  const fixture = preparedFixture();
  try {
    const archivePath = join(
      fixture.resourceDir,
      "butler-agent-0.0.20-darwin-arm64.tar.gz",
    );
    const archive = readFileSync(archivePath);
    archive[0] = archive[0]! ^ 0xff;
    writeFileSync(archivePath, archive);
    expect(() => verifyPreparedButlerResource(fixture.input)).toThrow(
      "prepared_resource_archive_hash_mismatch",
    );
  } finally {
    fixture.cleanup();
  }
});

test("same-size non-archive mutation invalidates the complete resource identity", () => {
  const fixture = preparedFixture();
  try {
    writeFileSync(join(fixture.resourceDir, "runtime", "worker.mjs"), "changed\n");
    expect(() => verifyPreparedButlerResource(fixture.input)).toThrow(
      "prepared_resource_dependency_closure_identity_mismatch",
    );
  } finally {
    fixture.cleanup();
  }
});

test("resource mode changes and special files invalidate or reject the resource", () => {
  const modeFixture = preparedFixture();
  try {
    execFileSync("chmod", [
      "4644", join(modeFixture.resourceDir, "runtime", "worker.mjs"),
    ]);
    expect(() => verifyPreparedButlerResource(modeFixture.input)).toThrow(
      "prepared_resource_identity_mismatch",
    );
  } finally {
    modeFixture.cleanup();
  }
  const fifoFixture = preparedFixture();
  try {
    execFileSync("mkfifo", [join(fifoFixture.resourceDir, "unexpected-fifo")]);
    expect(() => verifyPreparedButlerResource(fifoFixture.input)).toThrow(
      "prepared_resource_unreadable",
    );
  } finally {
    fifoFixture.cleanup();
  }
});

test("prepared resource consumption re-verifies identity after the consumer returns", async () => {
  const fixture = preparedFixture();
  try {
    await expect(withPreparedButlerResource(fixture.input, async () => {
      writeFileSync(join(fixture.resourceDir, "runtime", "worker.mjs"), "changed\n");
      return "consumer-returned";
    })).rejects.toMatchObject({
      code: "prepared_resource_dependency_closure_identity_mismatch",
    });
  } finally {
    fixture.cleanup();
  }
});

test("benchmark plan retains only the bounded prepared-resource identity", () => {
  const fixture = preparedFixture();
  try {
    const identity = preparedResourceIdentity(fixture.reference);
    const plan = createBenchmarkPlan({
      runId: "prepared-resource-plan",
      seed: 1,
      runRoot: join(fixture.root, "run"),
      sourceRoot: fixture.sourceRoot,
      controlledModel: "openai/gpt-5.5",
      preparedButlerResource: identity,
    });
    expect(plan.preparedButlerResource).toEqual(identity);
    expect(JSON.stringify(plan.preparedButlerResource)).not.toContain(
      fixture.resourceDir,
    );
    expect(JSON.stringify(plan.preparedButlerResource)).not.toContain("resourceDir");
  } finally {
    fixture.cleanup();
  }
});

test("canonical CLI parses the explicit prepared-resource pin", () => {
  const fixture = preparedFixture();
  try {
    const pinPath = join(fixture.root, "prepared-resource-pin.json");
    writeFileSync(pinPath, `${JSON.stringify(fixture.reference)}\n`, "utf8");
    const script = `
      import { parseOptions } from ${JSON.stringify(join(
        process.cwd(),
        "tests/support/agent-benchmark/cli.ts",
      ))};
      const options = parseOptions(${JSON.stringify([
        "plan",
        "--seed", "1",
        "--controlled-model", "openai/gpt-5.5",
        "--source-root", fixture.sourceRoot,
        "--run-root", join(fixture.root, "run"),
        "--prepared-butler-resource-pin", pinPath,
      ])});
      process.stdout.write(options.preparedButlerResource?.sourceRevision ?? "missing");
    `;
    expect(execFileSync("bun", ["-e", script], { encoding: "utf8" }))
      .toBe(fixture.reference.sourceRevision);
  } finally {
    fixture.cleanup();
  }
});

function inventory(root: string): { bytes: number; sha256: string } {
  return preparedResourceDirectoryIdentity(root);
}
