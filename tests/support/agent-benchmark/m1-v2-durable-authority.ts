import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { M1V2EvidenceExportIdentity } from "./m1-v2-evidence-export.ts";

const SCHEMA = "butler.agent-benchmark.sc01-durable-authority.v1" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

export interface M1V2DurableAuthority {
  schema: typeof SCHEMA;
  handle: string;
  sha256: string;
  identity: M1V2EvidenceExportIdentity;
}

export function createM1V2DurableAuthority(input: Omit<M1V2DurableAuthority, "schema">): M1V2DurableAuthority {
  return { schema: SCHEMA, ...input };
}

export function publishM1V2DurableAuthority(runRoot: string, authority: M1V2DurableAuthority): void {
  const path = authorityPath(runRoot, authority.identity.planIdentity, authority.identity.armKey);
  const directoryPath = resolve(path, "..");
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const relativeAuthorityRoot = relative(realpathSync(runRoot), realpathSync(directoryPath));
  if (hasSymlinkComponent(directoryPath) || !relativeAuthorityRoot || relativeAuthorityRoot.startsWith("..") || isAbsolute(relativeAuthorityRoot)) {
    throw new Error("sc01_export_authority_symlink_rejected");
  }
  const bytes = `${JSON.stringify(authority, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== bytes) throw new Error("sc01_export_authority_immutable_conflict");
    return;
  }
  const temporaryPath = `${path}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
    writeFileSync(fd, bytes, "utf8"); fsyncSync(fd); closeSync(fd); fd = null;
    linkSync(temporaryPath, path); unlinkSync(temporaryPath);
    const directory = openSync(directoryPath, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export function hasM1V2DurableAuthority(input: { runRoot: string; planIdentity: string; armKey: string }): boolean {
  return existsSync(authorityPath(input.runRoot, input.planIdentity, input.armKey));
}

export function readM1V2DurableAuthority(input: { runRoot: string; planIdentity: string; armKey: string }): M1V2DurableAuthority {
  const path = authorityPath(input.runRoot, input.planIdentity, input.armKey);
  if (hasSymlinkComponent(path)) throw new Error("sc01_export_authority_symlink_rejected");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error("sc01_export_authority_file_invalid");
  const authority = JSON.parse(readFileSync(path, "utf8")) as M1V2DurableAuthority;
  if (Object.keys(authority).length !== 4 || !["schema", "handle", "sha256", "identity"].every((key) => key in authority) ||
      authority.schema !== SCHEMA || authority.identity.planIdentity !== input.planIdentity ||
      authority.identity.armKey !== input.armKey || !SHA256.test(authority.sha256)) {
    throw new Error("sc01_export_authority_identity_mismatch");
  }
  return authority;
}

function authorityPath(runRoot: string, planIdentity: string, armKey: string): string {
  if (!SHA256.test(planIdentity) || !PUBLIC_ID.test(armKey)) throw new Error("sc01_export_authority_identity_invalid");
  const name = createHash("sha256").update(JSON.stringify({ planIdentity, armKey })).digest("hex");
  return join(resolve(runRoot), ".sc01-durable-authority", `${name}.json`);
}

function hasSymlinkComponent(path: string): boolean {
  const resolved = resolve(path); const parsed = parse(resolved); let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink() && current !== "/tmp" && current !== "/var") return true;
  }
  return false;
}
