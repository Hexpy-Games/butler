import type {
  BtccPersistenceTypes,
  ContinuationBinding,
} from "../../../btcc/gateway-api.ts";
import { contentRef } from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import { ManagedDeliveryOutboxWriter } from "./managed-delivery-outbox-writer.ts";
import { ManagedTurnProjectionWriter } from "./managed-turn-projection-writer.ts";
import { StoppedFinalizationRegistry } from "./stopped-finalization-registry.ts";

type FinalizationContinuationTransition = Extract<BtccPersistenceTypes["transition"], {
  kind: "accept_finalization_continuation";
}>;
type PreparedReportTransition = Extract<BtccPersistenceTypes["transition"], {
  kind: "accept_prepared_report";
}>;
type Transition = FinalizationContinuationTransition | PreparedReportTransition;
type TurnRecord = BtccPersistenceTypes["turn"];
type ManagedTurnState = BtccPersistenceTypes["managedTurnState"];
type FinalizationBinding = Extract<ContinuationBinding, {
  kind: "stopped_finalization";
}>;

export class ManagedFinalizationTransitionWriter {
  constructor(
    private readonly records: SqliteImmutableRecordStore,
    private readonly projection: ManagedTurnProjectionWriter,
    private readonly delivery: ManagedDeliveryOutboxWriter,
    private readonly registry: StoppedFinalizationRegistry,
  ) {}

  commit(turn: TurnRecord, nextRevision: number, transition: Transition): void {
    if (transition.kind === "accept_prepared_report") {
      this.delivery.prepare(turn.turnId, nextRevision, transition);
      this.advance(turn, nextRevision, transition.successor, {
        ...requiredManaged(turn), preparedReport: transition.product,
      }, {
        finalPayload: transition.product.finalPayload,
        finalDisposition: transition.product.finalPayload.disposition,
        outboxId: transition.deliveryOutbox.outboxId,
      });
      return;
    }
    const binding = requireBinding(transition);
    this.recordGoalAcceptance(transition);
    const finalizationOriginalGoalContract = this.registry.consume(
      binding,
      transition.finalization,
      turn.turnId,
    );
    const managed = {
      ...requiredManaged(turn),
      goalAcceptance: transition.product,
      finalizationOriginalGoalContract,
    };
    if (transition.finalization.resumeAt === "consolidation") {
      const program = transition.finalization.closedProgram;
      if (program.frontier !== "closed" || program.programId !== binding.programId ||
        program.manifestRevision !== binding.expectedManifestRevision) {
        throw new Error("Stopped Consolidation Program changed");
      }
      this.advance(turn, nextRevision, "consolidation", {
        ...managed,
        program,
      }, { goalContractRef: transition.product.goalContract.ref.id });
      return;
    }
    if (transition.finalization.resumeAt === "reporting") {
      const finalDossier = transition.finalization.finalDossier;
      if (finalDossier.dossier.programId !== binding.programId) {
        throw new Error("Stopped Reporting FinalDossier changed");
      }
      if (finalDossier.assessment) {
        this.insert("consolidation_assessment", finalDossier.assessment);
      }
      this.insert("final_dossier", finalDossier.dossier);
      this.advance(turn, nextRevision, "reporting", {
        ...managed,
        finalDossier,
      }, {
        goalContractRef: transition.product.goalContract.ref.id,
        finalDossierRef: finalDossier.dossier.ref.id,
      });
      return;
    }
    if (!transition.preparedReport || !transition.deliveryOutbox) {
      throw new Error("Stopped Delivery continuation is missing its prepared output");
    }
    assertDeliveryRebinding(turn, nextRevision, transition);
    this.delivery.prepare(turn.turnId, nextRevision, {
      product: transition.preparedReport,
      deliveryOutbox: transition.deliveryOutbox,
    });
    this.advance(turn, nextRevision, "delivery_committed", {
      ...managed,
      preparedReport: transition.preparedReport,
    }, {
      goalContractRef: transition.product.goalContract.ref.id,
      finalDossierRef: transition.preparedReport.report.finalDossierRef.id,
      finalPayload: transition.preparedReport.finalPayload,
      finalDisposition: transition.preparedReport.finalPayload.disposition,
      outboxId: transition.deliveryOutbox.outboxId,
    });
  }

  private recordGoalAcceptance(transition: FinalizationContinuationTransition): void {
    const { goalContract, authority, review } = transition.product;
    this.insert("goal_contract", goalContract);
    this.insert("authority_revision", authority);
    this.insert("goal_contract_review", review);
  }

  private advance(...input: Parameters<ManagedTurnProjectionWriter["advance"]>): void {
    this.projection.advance(...input);
  }

  private insert<T extends { ref: { id: string; sha256: string } }>(
    kind: string,
    value: T,
  ): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }
}

function assertDeliveryRebinding(
  turn: TurnRecord,
  nextRevision: number,
  transition: FinalizationContinuationTransition,
): void {
  if (transition.finalization.resumeAt !== "delivery" || !transition.preparedReport ||
    !transition.deliveryOutbox) {
    throw new Error("Stopped Delivery continuation is incomplete");
  }
  const source = transition.finalization.preparedReport;
  if (stableJson(transition.preparedReport.report) !== stableJson(source.report)) {
    throw new Error("Stopped Delivery PreparedReport changed");
  }
  const payloadBody = {
    turnId: turn.turnId,
    reportRef: source.report.ref,
    finalDossierRef: source.report.finalDossierRef,
    contentSha256: source.report.contentSha256,
    route: "managed" as const,
    disposition: source.finalPayload.disposition,
    content: source.report.content,
  };
  const payload = { ref: contentRef("payload", payloadBody), ...payloadBody };
  if (stableJson(transition.preparedReport.finalPayload) !== stableJson(payload)) {
    throw new Error("Stopped Delivery final payload changed");
  }
  const outboxId = digest(
    `btcc-canonical-delivery.v1\0${turn.turnId}\0${nextRevision}\0${payload.ref.sha256}`,
  );
  const outbox = transition.deliveryOutbox;
  if (outbox.outboxId !== outboxId || outbox.finalPayloadRef.id !== payload.ref.id ||
    outbox.finalPayloadRef.sha256 !== payload.ref.sha256 || outbox.content !== payload.content ||
    outbox.expectedMessageId !== digest(`btcc-assistant-message.v1\0${outboxId}`)) {
    throw new Error("Stopped Delivery Outbox changed");
  }
}

function requireBinding(
  transition: FinalizationContinuationTransition,
): FinalizationBinding {
  const binding = transition.product.authority.managedBinding.continuationBinding;
  if (binding.kind !== "stopped_finalization") {
    throw new Error("Finalization transition requires its exact continuation binding");
  }
  if (binding.context.finalization.resumeAt !== transition.finalization.resumeAt) {
    throw new Error("Finalization continuation resume point changed");
  }
  return binding;
}

function requiredManaged(turn: TurnRecord): ManagedTurnState {
  if (!turn.managed) throw new Error(`Managed state is missing at ${turn.semanticState}`);
  return turn.managed;
}
