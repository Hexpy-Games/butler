import { createHash } from "node:crypto";
import {
  lstatSync,
  closeSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  sourceCompatibilitySha256,
  sourceRevision,
} from "./prepared-butler-source-identity.ts";
import { validatePreparedButlerProvenance } from "./prepared-butler-provenance.ts";
import { PreparedButlerResourceError } from "./prepared-butler-resource-error.ts";
export { PreparedButlerResourceError } from "./prepared-butler-resource-error.ts";
export { sourceCompatibilitySha256 } from "./prepared-butler-source-identity.ts";

export interface PreparedButlerResourceReference {
  resourceDir: string;
  sourceRevision: string;
  sourceCompatibilitySha256: string;
  manifestSha256: string;
  dependencyClosureSha256: string;
  resourceSha256: string;
  resourceBytes: number;
  archiveSha256: string;
  archiveBytes: number;
}

export interface VerifiedPreparedButlerResource {
  resourceDir: string;
  identity: {
    sourceRevision: string;
    sourceCompatibilitySha256: string;
    manifestSha256: string;
    dependencyClosureSha256: string;
    resourceSha256: string;
    resourceBytes: number;
    archiveSha256: string;
    archiveBytes: number;
  };
}
export type PreparedButlerResourceIdentity =
  VerifiedPreparedButlerResource["identity"];

export function preparedResourceHarnessOptions(input: {
  reference?: PreparedButlerResourceReference;
  sourceRoot: string;
  sourceRevision: string;
}): {
  bundledAgentResourceDir: string;
  bundledAgentResourceIdentity: PreparedButlerResourceIdentity;
} | Record<string, never> {
  const reference = input.reference;
  if (!reference) return {};
  const verified = verifyPreparedButlerResource({ ...input, reference });
  return {
    bundledAgentResourceDir: verified.resourceDir,
    bundledAgentResourceIdentity: verified.identity,
  };
}

export async function withPreparedButlerResource<T>(
  input: {
    reference?: PreparedButlerResourceReference;
    sourceRoot: string;
    sourceRevision: string;
  },
  consume: (options: ReturnType<typeof preparedResourceHarnessOptions>) => Promise<T>,
): Promise<T> {
  const options = preparedResourceHarnessOptions(input);
  try {
    return await consume(options);
  } finally {
    if (input.reference) verifyPreparedButlerResource({
      reference: input.reference,
      sourceRoot: input.sourceRoot,
      sourceRevision: input.sourceRevision,
    });
  }
}

export function preparedResourceIdentity(
  reference: PreparedButlerResourceReference,
): VerifiedPreparedButlerResource["identity"] {
  const validated = validateReference(reference);
  return {
    sourceRevision: validated.sourceRevision,
    sourceCompatibilitySha256: validated.sourceCompatibilitySha256,
    manifestSha256: validated.manifestSha256,
    dependencyClosureSha256: validated.dependencyClosureSha256,
    resourceSha256: validated.resourceSha256,
    resourceBytes: validated.resourceBytes,
    archiveSha256: validated.archiveSha256,
    archiveBytes: validated.archiveBytes,
  };
}

export function readPreparedButlerResourceReference(
  path: string,
): PreparedButlerResourceReference {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PreparedButlerResourceReference;
    return validateReference(value);
  } catch (error) {
    if (error instanceof PreparedButlerResourceError) throw error;
    throw new PreparedButlerResourceError("prepared_resource_reference_invalid");
  }
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

export function verifyPreparedButlerResource(input: {
  reference: PreparedButlerResourceReference;
  sourceRoot: string;
  sourceRevision: string;
}): VerifiedPreparedButlerResource {
  const reference = validateReference(input.reference);
  if (sourceRevision(input.sourceRoot) !== input.sourceRevision) {
    throw new PreparedButlerResourceError("prepared_resource_current_source_revision_mismatch");
  }
  const resourceDir = resolve(reference.resourceDir);
  let resourceStat;
  try {
    resourceStat = lstatSync(resourceDir);
  } catch {
    throw new PreparedButlerResourceError("prepared_resource_missing");
  }
  if (!resourceStat.isDirectory() || resourceStat.isSymbolicLink()) {
    throw new PreparedButlerResourceError("prepared_resource_unreadable");
  }
  let compatibilitySha256: string;
  try {
    compatibilitySha256 = sourceCompatibilitySha256(input.sourceRoot);
  } catch {
    throw new PreparedButlerResourceError("prepared_resource_source_unreadable");
  }
  if (compatibilitySha256 !== reference.sourceCompatibilitySha256) {
    throw new PreparedButlerResourceError("prepared_resource_source_compatibility_mismatch_repin_required");
  }
  const manifestPath = join(resourceDir, "agent-release-manifest.json");
  const manifestBytes = readableFile(
    manifestPath,
    "prepared_resource_manifest_missing",
    MAX_MANIFEST_BYTES,
  );
  if (digest(manifestBytes) !== reference.manifestSha256) {
    throw new PreparedButlerResourceError("prepared_resource_manifest_hash_mismatch");
  }
  const artifactName = validatePreparedButlerProvenance({
    sourceRoot: input.sourceRoot,
    resourceDir,
    manifestBytes,
    manifestSha256: reference.manifestSha256,
    dependencyClosureSha256: reference.dependencyClosureSha256,
    archiveSha256: reference.archiveSha256,
  });
  const archivePath = join(resourceDir, artifactName);
  const archiveStat = readableFileStat(
    archivePath,
    "prepared_resource_archive_missing",
    MAX_ARCHIVE_BYTES,
  );
  if (archiveStat.size !== reference.archiveBytes) {
    throw new PreparedButlerResourceError("prepared_resource_archive_size_mismatch");
  }
  if (digestFile(archivePath) !== reference.archiveSha256) {
    throw new PreparedButlerResourceError("prepared_resource_archive_hash_mismatch");
  }
  const resourceIdentity = directoryIdentity(resourceDir);
  if (resourceIdentity.bytes !== reference.resourceBytes ||
      resourceIdentity.sha256 !== reference.resourceSha256) {
    throw new PreparedButlerResourceError("prepared_resource_identity_mismatch");
  }
  return {
    resourceDir,
    identity: {
      sourceRevision: reference.sourceRevision,
      sourceCompatibilitySha256: reference.sourceCompatibilitySha256,
      manifestSha256: reference.manifestSha256,
      dependencyClosureSha256: reference.dependencyClosureSha256,
      resourceSha256: reference.resourceSha256,
      resourceBytes: reference.resourceBytes,
      archiveSha256: reference.archiveSha256,
      archiveBytes: reference.archiveBytes,
    },
  };
}


function validateReference(
  value: PreparedButlerResourceReference,
): PreparedButlerResourceReference {
  if (!value || typeof value.resourceDir !== "string" || !value.resourceDir.trim()) {
    throw new PreparedButlerResourceError("prepared_resource_reference_invalid");
  }
  if (!/^[a-f0-9]{40}$/u.test(value.sourceRevision) ||
      ![
        value.sourceCompatibilitySha256,
        value.manifestSha256,
        value.dependencyClosureSha256,
        value.resourceSha256,
        value.archiveSha256,
      ]
        .every((digest) => /^[a-f0-9]{64}$/u.test(digest)) ||
      !Number.isSafeInteger(value.resourceBytes) || value.resourceBytes <= 0 ||
      !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes <= 0) {
    throw new PreparedButlerResourceError("prepared_resource_reference_invalid");
  }
  return value;
}

export function preparedResourceDirectoryIdentity(
  resourceDir: string,
): { sha256: string; bytes: number } {
  return directoryIdentity(resolve(resourceDir));
}

function directoryIdentity(root: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256");
  let bytes = 0;
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const label = relative(root, path).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) {
      throw new PreparedButlerResourceError("prepared_resource_unreadable");
    }
    if (stat.isFile()) {
      bytes += stat.size;
      hash.update(`file\0${label}\0${stat.mode & 0o7777}\0${stat.size}\0`);
      hash.update(digestFile(path));
      return;
    }
    if (!stat.isDirectory()) {
      throw new PreparedButlerResourceError("prepared_resource_unreadable");
    }
    hash.update(`dir\0${label}\0${stat.mode & 0o7777}\0`);
    for (const entry of readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      visit(join(path, entry.name));
    }
  };
  visit(root);
  return { sha256: hash.digest("hex"), bytes };
}

function readableFile(path: string, code: string, maxBytes: number): Buffer {
  const stat = readableFileStat(path, code, maxBytes);
  if (stat.size > maxBytes) throw new PreparedButlerResourceError(code);
  try {
    return readFileSync(path);
  } catch {
    throw new PreparedButlerResourceError(code);
  }
}

function readableFileStat(path: string, code: string, maxBytes: number) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error("not a bounded regular file");
    }
    return stat;
  } catch {
    throw new PreparedButlerResourceError(code);
  }
}

function digestFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
