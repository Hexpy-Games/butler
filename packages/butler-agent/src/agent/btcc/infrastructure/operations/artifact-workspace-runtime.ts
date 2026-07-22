import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ArtifactWorkspaceRuntime,
  ProvisionWorkspaceCommand,
  WorkspaceProvision,
} from "../../artifact/index.ts";
import { contentRef, digest, stableJson } from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import { ArtifactStore, type StoredWorkspace } from "./artifact-store.ts";
import {
  captureTargetSnapshot,
  materializeSnapshot,
  removeOwnedRoot,
  workspaceContentRoot,
} from "./target-snapshot.ts";

export class ProductionArtifactWorkspaceRuntime implements ArtifactWorkspaceRuntime {
  constructor(
    private readonly options: ProductionOperationRuntimeOptions,
    private readonly store: ArtifactStore,
  ) {}

  async acquireProgramWorkspace(command: ProvisionWorkspaceCommand): Promise<WorkspaceProvision> {
    const key = workspaceKey(command.programId, command.targetScopeRef);
    const existing = this.store.loadWorkspaceByKey(key);
    if (existing) {
      requireOwnedWorkspace(existing);
      return existing.provision;
    }
    const resolved = await this.options.resolveTargetScope(command.targetScopeRef);
    if (!isAbsolute(resolved.targetPath)) {
      throw new Error("BTCC target scope resolver must return an absolute path");
    }
    const requestedPath = resolve(resolved.targetPath);
    const baselineSnapshot = captureTargetSnapshot(requestedPath);
    const targetPath = existsSync(requestedPath)
      ? realpathSync(requestedPath)
      : requestedPath;
    const provision = createProvision(command, baselineSnapshot.ref, baselineSnapshot.targetKind);
    const workspaceRoot = join(
      this.options.butlerData,
      "runtime",
      "btcc-artifacts",
      "workspaces",
      provision.workspace.ref.id,
    );
    materializeOwnedWorkspace(workspaceRoot, provision, baselineSnapshot);
    const stored: StoredWorkspace = {
      key,
      provision,
      targetPath,
      targetKind: baselineSnapshot.targetKind,
      baselineTargetState: baselineSnapshot.targetState,
      workspaceRoot,
      baselineSnapshotRef: baselineSnapshot.ref,
    };
    this.store.saveWorkspace(stored, baselineSnapshot);
    return provision;
  }
}

function createProvision(
  command: ProvisionWorkspaceCommand,
  snapshotRef: { id: string; sha256: string },
  targetKind: "file" | "directory",
): WorkspaceProvision {
  const outbox = record("workspace-provision-outbox", command);
  const baseline = record("target-baseline", {
    targetScopeRef: command.targetScopeRef,
    capturedByProvisionOutboxRef: outbox.ref,
    snapshotRef,
  });
  const ownedRootRef = contentRef("owned-isolation-root", {
    programId: command.programId,
    baselineRef: baseline.ref,
  });
  const workspace = record("program-artifact-workspace", {
    programId: command.programId,
    provisionOutboxRef: outbox.ref,
    targetBaselineRef: baseline.ref,
    ownedRootRef,
    operationRoot: targetKind === "file"
      ? { kind: "file" as const, relativeTarget: "target" as const }
      : { kind: "directory" as const, relativeTarget: "." as const },
  });
  const receipt = record("workspace-provision-receipt", {
    workspaceRef: workspace.ref,
    outboxRef: outbox.ref,
    targetBaselineRef: baseline.ref,
    ownerMarkerSha256: ownedRootRef.sha256,
  });
  const outcome = record("workspace-provision-outcome", {
    outboxRef: outbox.ref,
    receiptRef: receipt.ref,
    observedTargetRevisionRefs: [snapshotRef],
  });
  return { outbox, baseline, workspace, receipt, outcome };
}

function materializeOwnedWorkspace(
  root: string,
  provision: WorkspaceProvision,
  snapshotValue: ReturnType<typeof captureTargetSnapshot>,
): void {
  if (existsSync(root)) {
    const marker = readOwnerMarker(root);
    if (marker.workspaceId !== provision.workspace.ref.id ||
      marker.ownerMarkerSha256 !== provision.receipt.ownerMarkerSha256) {
      throw new Error("BTCC workspace root exists without matching ownership");
    }
    return;
  }
  const stage = `${root}.provisioning-${process.pid}`;
  removeOwnedRoot(stage);
  mkdirSync(stage, { recursive: true });
  materializeSnapshot(snapshotValue, workspaceContentRoot(stage));
  writeFileSync(join(stage, ".butler-owner.json"), JSON.stringify({
    workspaceId: provision.workspace.ref.id,
    ownerMarkerSha256: provision.receipt.ownerMarkerSha256,
  }));
  mkdirSync(resolve(root, ".."), { recursive: true });
  renameSync(stage, root);
}

function requireOwnedWorkspace(workspace: StoredWorkspace): void {
  if (!existsSync(workspace.workspaceRoot)) {
    throw new Error("BTCC owned workspace is missing after restart");
  }
  const marker = readOwnerMarker(workspace.workspaceRoot);
  if (marker.workspaceId !== workspace.provision.workspace.ref.id ||
    marker.ownerMarkerSha256 !== workspace.provision.receipt.ownerMarkerSha256) {
    throw new Error("BTCC owned workspace marker does not match its durable mapping");
  }
}

function readOwnerMarker(root: string): { workspaceId: string; ownerMarkerSha256: string } {
  return JSON.parse(readFileSync(join(root, ".butler-owner.json"), "utf8")) as {
    workspaceId: string;
    ownerMarkerSha256: string;
  };
}

function workspaceKey(programId: string, targetScopeRef: string): string {
  return digest(stableJson({ programId, targetScopeRef }));
}

function record<Body extends Record<string, unknown>>(kind: string, body: Body) {
  return { ref: contentRef(kind, body), ...body };
}
