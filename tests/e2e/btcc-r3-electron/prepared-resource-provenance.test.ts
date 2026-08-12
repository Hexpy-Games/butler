import { expect, test } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  preparedResourceDirectoryIdentity,
  verifyPreparedButlerResource,
} from "../../support/agent-benchmark/prepared-butler-resource.ts";
import { digest, preparedFixture } from "./prepared-resource-fixture.ts";

test("dependency closure tampering is rejected even when its pin is recomputed", () => {
  const fixture = preparedFixture();
  try {
    const closurePath = join(fixture.resourceDir, "dependency-closure.json");
    const closure = JSON.parse(readFileSync(closurePath, "utf8"));
    closure.payload.sha256 = "f".repeat(64);
    const bytes = Buffer.from(`${JSON.stringify(closure)}\n`);
    writeFileSync(closurePath, bytes);
    expect(() => verifyPreparedButlerResource({
      ...fixture.input,
      reference: {
        ...fixture.reference,
        dependencyClosureSha256: digest(bytes),
      },
    })).toThrow("prepared_resource_dependency_closure_identity_mismatch");
  } finally {
    fixture.cleanup();
  }
});

test("artifact platform, URL, and unsigned signatures match the producer manifest", () => {
  type Artifact = {
    artifactName: string;
    downloadUrl: string;
    signature: string | null;
    integrity: { signature: string | null };
  };
  type Manifest = { artifacts: Artifact[] };
  const mutations: Array<(artifact: Artifact) => void> = [
    (artifact) => {
      artifact.artifactName = "butler-agent-0.0.20-linux-x64.tar.gz";
      artifact.downloadUrl = `bundled-agent/${artifact.artifactName}`;
    },
    (artifact) => {
      artifact.artifactName = "butler-agent-0.0.20-windows-x64.tar.gz";
      artifact.downloadUrl = `bundled-agent/${artifact.artifactName}`;
    },
    (artifact) => { artifact.downloadUrl = "bundled-agent/forged.tar.gz"; },
    (artifact) => {
      artifact.signature = "forged";
      artifact.integrity.signature = "forged";
    },
  ];
  for (const mutate of mutations) {
    const fixture = preparedFixture();
    try {
      const manifestPath = join(fixture.resourceDir, "agent-release-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      mutate(manifest.artifacts[0]!);
      const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      writeFileSync(manifestPath, bytes);
      expect(() => verifyPreparedButlerResource({
        ...fixture.input,
        reference: { ...fixture.reference, manifestSha256: digest(bytes) },
      })).toThrow(/prepared_resource_manifest_(?:identity|provenance)_mismatch|prepared_resource_manifest_provenance_invalid/u);
    } finally {
      fixture.cleanup();
    }
  }
});

test("an internally consistent foreign-platform resource is rejected by the host boundary", () => {
  type Manifest = {
    artifacts: Array<{ artifactName: string; downloadUrl: string }>;
    cliLaunchers: Array<{ platform: string; path: string; buildTarget: string }>;
  };
  const fixture = preparedFixture();
  try {
    const manifestPath = join(fixture.resourceDir, "agent-release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const originalName = manifest.artifacts[0]!.artifactName;
    const foreignPlatform = process.platform === "linux" ? "darwin-arm64" : "linux-x64";
    const foreignName = `butler-agent-0.0.20-${foreignPlatform}.tar.gz`;
    renameSync(
      join(fixture.resourceDir, originalName),
      join(fixture.resourceDir, foreignName),
    );
    manifest.artifacts[0]!.artifactName = foreignName;
    manifest.artifacts[0]!.downloadUrl = `bundled-agent/${foreignName}`;
    manifest.cliLaunchers = [{
      platform: foreignPlatform,
      path: `packages/butler-agent/resources/cli/${foreignPlatform}/butler`,
      buildTarget: `bun-${foreignPlatform}`,
    }];
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    writeFileSync(manifestPath, manifestBytes);

    const closurePath = join(fixture.resourceDir, "dependency-closure.json");
    const closureBytes = Buffer.from(
      readFileSync(closurePath, "utf8").replaceAll(originalName, foreignName),
    );
    writeFileSync(closurePath, closureBytes);
    const resourceIdentity = preparedResourceDirectoryIdentity(fixture.resourceDir);
    expect(() => verifyPreparedButlerResource({
      ...fixture.input,
      reference: {
        ...fixture.reference,
        manifestSha256: digest(manifestBytes),
        dependencyClosureSha256: digest(closureBytes),
        resourceSha256: resourceIdentity.sha256,
        resourceBytes: resourceIdentity.bytes,
      },
    })).toThrow("prepared_resource_manifest_provenance_invalid");
  } finally {
    fixture.cleanup();
  }
});

test("all producer-owned dependency closure metadata is immutable", () => {
  type Dependency = { id: string; title: string; source: string; paths: string[] };
  type Closure = { appOwnedDependencies: Dependency[] };
  const mutations: Array<(closure: Closure) => void> = [
    (closure) => { closure.appOwnedDependencies[0]!.title = "Forged shell"; },
    (closure) => { closure.appOwnedDependencies[0]!.paths = ["forged/path"]; },
    (closure) => { closure.appOwnedDependencies[0]!.source = "signed-butler-payload"; },
    (closure) => { closure.appOwnedDependencies.push({
      ...structuredClone(closure.appOwnedDependencies[0]!),
      id: "extra-dependency",
    }); },
    (closure) => { closure.appOwnedDependencies.push(
      structuredClone(closure.appOwnedDependencies[0]!),
    ); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = preparedFixture();
    try {
      const closurePath = join(fixture.resourceDir, "dependency-closure.json");
      const closure = JSON.parse(readFileSync(closurePath, "utf8")) as Closure;
      mutate(closure);
      const bytes = Buffer.from(`${JSON.stringify(closure)}\n`);
      writeFileSync(closurePath, bytes);
      const resourceIdentity = preparedResourceDirectoryIdentity(fixture.resourceDir);
      let error: unknown;
      try {
        verifyPreparedButlerResource({
          ...fixture.input,
          reference: {
            ...fixture.reference,
            dependencyClosureSha256: digest(bytes),
            resourceSha256: resourceIdentity.sha256,
            resourceBytes: resourceIdentity.bytes,
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: index === 0
          ? "prepared_resource_dependency_closure_identity_mismatch"
          : expect.stringMatching(/^prepared_resource_dependency_closure_(?:identity_mismatch|invalid)$/u),
      });
    } finally {
      fixture.cleanup();
    }
  }
});
