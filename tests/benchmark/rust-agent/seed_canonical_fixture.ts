/** Setup-only: write original canonical sources with the production conversation writer. */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Source = {
  id: string; session_id: string; turn_id: string; message_id: string;
  at: string; text: string;
};
type Workload = {
  sources: Source[];
  workspace_seed: { path: string; text: string };
};

const [dataArgument, workspaceArgument] = process.argv.slice(2);
const sourceRootArgument = process.env.BUTLER_BENCHMARK_AGENT_SOURCE_ROOT;
if (!dataArgument || !workspaceArgument || !sourceRootArgument) {
  throw new Error("usage: BUTLER_BENCHMARK_AGENT_SOURCE_ROOT=<installed agent src> bun seed_canonical_fixture.ts <fresh isolated data> <fresh isolated workspace>");
}
const data = resolve(dataArgument);
const workspace = resolve(workspaceArgument);
const sourceRoot = resolve(sourceRootArgument);
const repository = resolve(import.meta.dir, "../../..");
const sourceHome = resolve(process.env.HOME ?? "/nonexistent", ".butler");
for (const path of [data, workspace]) {
  if (path === repository || path.startsWith(repository + "/") ||
      path === sourceHome || path.startsWith(sourceHome + "/")) {
    throw new Error("fixture target overlaps source or production data");
  }
  if (existsSync(path)) {
    // The caller creates a fresh 0700 parent; reject pre-existing arm roots.
    throw new Error("fixture target already exists");
  }
}
if (data === workspace || data.startsWith(workspace + "/") || workspace.startsWith(data + "/")) {
  throw new Error("fixture roots overlap");
}
for (const path of [dirname(data), dirname(workspace)]) {
  if (lstatSync(path).isSymbolicLink()) throw new Error("fixture parent is symbolic link");
}

const workload = JSON.parse(readFileSync(join(import.meta.dir, "workload.json"), "utf8")) as Workload;
const storeModule = await import(pathToFileURL(join(sourceRoot, "agent", "conversation", "store.ts")).href);
const admissionModule = await import(pathToFileURL(join(sourceRoot, "agent", "conversation", "session-admission.ts")).href);
const { AgentConversationStore } = storeModule;
const { classifyConversationOrigin } = admissionModule;
mkdirSync(data, { mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
const store = new AgentConversationStore({ butlerData: data });
try {
  for (const source of workload.sources) {
    const originRef = `btcc:${source.turn_id}:${source.message_id}`;
    const origin = classifyConversationOrigin({
      ref: originRef,
      publicIngress: true,
      internalControl: false,
      evidenceAvailable: true,
      evidence: [{ kind: "btcc_admission", ref: originRef, sha256: null }],
    });
    store.beginTurn({
      gateway: "app",
      externalSessionId: `rust-benchmark-source-${source.id.toLowerCase()}`,
      sessionId: source.session_id,
      turnId: source.turn_id,
      actor: "user",
      now: source.at,
    });
    store.appendUserMessage({
      sessionId: source.session_id,
      turnId: source.turn_id,
      messageId: source.message_id,
      text: source.text,
      sourceGateway: "app",
      sourceRef: `rust-benchmark-source-${source.id.toLowerCase()}`,
      originKind: origin.kind,
      originRef: origin.ref,
      originReason: origin.reason,
      originVersion: origin.version,
      originEvidence: origin.evidence,
      now: source.at,
    });
    store.finalizeTurn({ turnId: source.turn_id, status: "complete", completedAt: source.at });
  }
} finally {
  store.close();
}
const seedPath = resolve(workspace, workload.workspace_seed.path);
if (!seedPath.startsWith(workspace + "/")) throw new Error("workspace seed escapes root");
mkdirSync(dirname(seedPath), { recursive: true, mode: 0o700 });
writeFileSync(seedPath, workload.workspace_seed.text, { mode: 0o600, flag: "wx" });
// Readiness/projection must subsequently be checked through each actual arm.
process.stdout.write(JSON.stringify({ seeded_sources: workload.sources.length, workspace_seeded: true }) + "\n");
