import type { ArtifactWorkspaceRuntime } from "../../agent/btcc/artifact/index.ts";
import { contentRef } from "../../agent/btcc/core/index.ts";

export class HarnessArtifactWorkspace implements ArtifactWorkspaceRuntime {
  private readonly workspaces = new Map<string, Awaited<
    ReturnType<ArtifactWorkspaceRuntime["acquireProgramWorkspace"]>
  >>();

  async acquireProgramWorkspace(
    command: Parameters<ArtifactWorkspaceRuntime["acquireProgramWorkspace"]>[0],
  ) {
    const key = `${command.programId}\0${command.targetScopeRef}`;
    const existing = this.workspaces.get(key);
    if (existing) return existing;
    const outbox = record("workspace-provision-outbox", command);
    const snapshotRef = contentRef("materializable-target-snapshot", {
      targetScopeRef: command.targetScopeRef,
      policy: command.baselinePolicy,
    });
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
    const provision = { outbox, baseline, workspace, receipt, outcome };
    this.workspaces.set(key, provision);
    return provision;
  }
}

function record<Body extends Record<string, unknown>>(kind: string, body: Body) {
  return { ref: contentRef(kind, body), ...body };
}
