/** Setup-only folder selection token for this campaign's own scratch workspace. */
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [baselineArgument, workspaceArgument, secretArgument, tokenArgument] = process.argv.slice(2);
if (!baselineArgument || !workspaceArgument || !secretArgument || !tokenArgument) {
  throw new Error("usage: bun issue_workspace_token.ts <frozen-baseline-root> <scratch-workspace> <0600-secret-file> <new-0600-token-file>");
}
const sourceModule = join(resolve(baselineArgument),
  "packages/butler-agent/src/gateways/app/domain/projects/project-folder-selection-token.ts");
const { createProjectFolderSelectionToken } = await import(pathToFileURL(sourceModule).href);
const workspace = resolve(workspaceArgument);
const secretFile = resolve(secretArgument);
const tokenFile = resolve(tokenArgument);
const stat = lstatSync(workspace);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
  throw new Error("scratch workspace must be a private directory");
}
const secretStat = lstatSync(secretFile);
if (!secretStat.isFile() || secretStat.isSymbolicLink() || (secretStat.mode & 0o077) !== 0) {
  throw new Error("scratch secret must be a private regular file");
}
const secret = readFileSync(secretFile, "utf8").trim();
if (secret.length < 32) throw new Error("scratch secret is too short");
const token = createProjectFolderSelectionToken(workspace, secret);
writeFileSync(tokenFile, token, { mode: 0o600, flag: "wx" });
// Deliberately no stdout: the caller reads and submits this opaque token only.
