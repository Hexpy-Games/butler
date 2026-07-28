import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";
import { contentRef } from "../../agent/btcc/core/index.ts";

type OperationExecutor = BtccRuntimeDependencies["operations"];
type PerformInput = Parameters<OperationExecutor["perform"]>[0];
type OperationResult = Awaited<ReturnType<OperationExecutor["perform"]>>;

export class HarnessOperationExecutor implements OperationExecutor {
  callCount = 0;
  private readonly workspaceArtifacts = new Map<string, string>();
  private promotedArtifact?: string;

  constructor(private readonly dataRoot: string) {
    this.restoreArtifactState();
  }

  artifactSnapshot() {
    return {
      workspace: Object.fromEntries(this.workspaceArtifacts),
      promoted: this.promotedArtifact,
    };
  }

  async perform({ request }: PerformInput): Promise<OperationResult> {
    this.callCount += 1;
    if (request.kind === "turn_local_effect") {
      const content = JSON.stringify({ applied: request.input });
      return {
        requestId: request.requestId,
        outcome: "turn_local_effect_applied",
        observationRef: ref("turn-local-effect", request.requestId, content),
        content,
      };
    }
    if (request.kind === "repository_promotion") {
      const content = this.requirePromotionCandidate();
      this.promotedArtifact = content;
      this.persistArtifactState();
      const transaction = record("repository-promotion-transaction", {
        requestId: request.requestId,
        authorizationRef: request.authorizationRef,
        candidateRef: request.candidateRef,
        resolutionRef: request.resolutionRef,
        baselineRef: request.baselineRef,
        commitPrimitive: "atomic_root_exchange",
      });
      const prepared = journal(transaction.ref, undefined, "prepared");
      const baselineVerified = journal(transaction.ref, prepared.ref, "baseline_verified");
      const intent = journal(transaction.ref, baselineVerified.ref, "commit_intent_durable");
      const commitReceipt = record("promotion-commit-receipt", {
        transactionRef: transaction.ref,
        targetStateAfterSha256: digest(content),
        primitive: "atomic_root_exchange",
      });
      const observed = journal(transaction.ref, intent.ref, "commit_observed", {
        commitReceiptRef: commitReceipt.ref,
      });
      const promotedSnapshot = record("promoted-target-snapshot", {
        transactionRef: transaction.ref,
        commitReceiptRef: commitReceipt.ref,
        completeTargetSha256: digest(content),
      });
      const cleanupReceipt = record("promotion-cleanup-receipt", {
        transactionRef: transaction.ref,
        commitObservedJournalRef: observed.ref,
        removedOwnedRootRefs: [],
      });
      const closed = journal(transaction.ref, observed.ref, "closed", {
        cleanupReceiptRef: cleanupReceipt.ref,
        promotedSnapshotRef: promotedSnapshot.ref,
      });
      return {
        requestId: request.requestId,
        outcome: "promoted",
        observationRef: ref("promotion-operation", request.requestId, content),
        transactionRef: transaction.ref,
        commitJournalRef: closed.ref,
        promotionReceiptRef: commitReceipt.ref,
        promotedSnapshotRef: promotedSnapshot.ref,
        promotionRecords: {
          transaction,
          journals: [prepared, baselineVerified, intent, observed, closed],
          commitReceipt,
          promotedSnapshot,
          cleanupReceipt,
        },
        content,
      };
    }
    if (request.kind === "workspace_artifact_action") {
      const content = typeof request.input.content === "string"
        ? request.input.content
        : JSON.stringify(request.input);
      this.workspaceArtifacts.set(request.relativeTarget, content);
      this.persistArtifactState();
      return {
        requestId: request.requestId,
        outcome: "workspace_artifact_applied",
        observationRef: ref("workspace-operation", request.requestId, content),
        artifactRevisionRef: ref("artifact-revision", request.requestId, content),
        targetSnapshotRef: ref("materializable-snapshot", request.requestId, content),
        content,
      };
    }
    if (request.kind === "workspace_artifact_observation") {
      const content = this.requireReviewSource();
      return {
        requestId: request.requestId,
        outcome: "observed",
        observationRef: ref("workspace-observation", request.requestId, content),
        targetSnapshotRef: ref("materializable-snapshot", request.requestId, content),
        content,
      };
    }
    if (request.kind === "review_validation") {
      const artifact = this.requireReviewSource();
      const content = `validated artifact sha256:${digest(artifact)}`;
      return {
        requestId: request.requestId,
        outcome: "review_validated",
        observationRef: ref("review-validation", request.requestId, content),
        validationReceiptRef: ref("review-validation-receipt", request.requestId, content),
        content,
      };
    }
    const content = observationFor(request.capabilityRef);
    return {
      requestId: request.requestId,
      outcome: "observed",
      observationRef: ref("harness-observation", request.requestId, content),
      content,
    };
  }

  private requireReviewSource(): string {
    const artifact = [...this.workspaceArtifacts.values()].at(-1);
    if (!artifact) throw new Error("Harness Review requires a materialized artifact");
    return artifact;
  }

  private requirePromotionCandidate(): string {
    const artifact = this.requireReviewSource();
    if (artifact.length === 0) throw new Error("Harness promotion candidate is empty");
    return artifact;
  }

  private restoreArtifactState(): void {
    const path = this.statePath();
    if (!existsSync(path)) return;
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      workspace: Record<string, string>;
      promoted?: string;
    };
    for (const [target, content] of Object.entries(state.workspace)) {
      this.workspaceArtifacts.set(target, content);
    }
    this.promotedArtifact = state.promoted;
  }

  private persistArtifactState(): void {
    const path = this.statePath();
    const pending = `${path}.pending`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(pending, JSON.stringify(this.artifactSnapshot()), "utf8");
    renameSync(pending, path);
  }

  private statePath(): string {
    return join(this.dataRoot, "runtime", "harness-artifacts.json");
  }
}

function record(kind: string, body: Record<string, unknown>) {
  return { ref: contentRef(kind, body), ...body };
}

function journal(
  transactionRef: { id: string; sha256: string },
  previousRef: { id: string; sha256: string } | undefined,
  state: string,
  extra: Record<string, unknown> = {},
) {
  const body = {
    transactionRef,
    ...(previousRef ? { previousRef } : {}),
    sequence: previousRef ? journalSequence(state) : 1,
    state,
    ...extra,
  };
  return { ref: contentRef("repository-promotion-journal", body), ...body };
}

function journalSequence(state: string): number {
  return ["prepared", "baseline_verified", "commit_intent_durable", "commit_observed", "closed"]
    .indexOf(state) + 1;
}

function observationFor(capabilityRef: string): string {
  switch (capabilityRef) {
    case "weather:seoul-current":
      return "서울은 현재 맑고 24도입니다.";
    case "meme:current-first":
      return "현재 밈 관찰 1: 월요일을 버티는 직장인 고양이";
    case "meme:current-second":
      return "현재 밈 관찰 2: 예상과 현실을 비교하는 두 장면 형식";
    default:
      throw new Error(`Unknown harness observation capability: ${capabilityRef}`);
  }
}

function ref(kind: string, identity: string, content: string) {
  return {
    id: digest(`btcc-${kind}.v1\0${identity}\0${content}`),
    sha256: digest(content),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
