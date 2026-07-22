import {
  contentRef,
  digest,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { FinalDossierProduct } from "../consolidation/index.ts";
import type { PreparedReportProduct } from "./contracts.ts";
import { reportingSubmissionSchema } from "./submission-schema.ts";

const CONTRACT: PhaseContract = {
  phase: "reporting",
  objective: "render_the_accepted_final_dossier_truthfully",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "render_final_dossier_truthfully", "guard_public_claims",
    "guard_model_identity_privacy_omissions", "apply_accepted_output_preferences",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair", "no_learning_on_delivery_path",
  ],
};

const codec: PhaseCodec<PreparedReportProduct> = {
  submissionSchema: reportingSubmissionSchema,
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Reporting state");
    const dossier = state.finalDossier as FinalDossierProduct | undefined;
    if (dossier?.kind !== "final_dossier") {
      throw new Error("Reporting is missing the accepted FinalDossier");
    }
    const value = requireRecord(submission, "Reporting submission");
    requireLiteral(value.kind, "prepared_report", "Reporting kind");
    const content = requireString(value.content, "report content");
    const reportBody = {
      finalDossierRef: dossier.dossier.ref,
      content,
      contentSha256: digest(content),
    };
    const report = { ref: contentRef("prepared-report", reportBody), ...reportBody };
    const payloadBody = {
      turnId: envelope.binding.turnId,
      reportRef: report.ref,
      finalDossierRef: dossier.dossier.ref,
      contentSha256: report.contentSha256,
      route: "managed" as const,
      disposition: dossier.dossier.disposition,
      content,
    };
    return {
      kind: "prepared_report",
      report,
      finalPayload: { ref: contentRef("payload", payloadBody), ...payloadBody },
    };
  },
};

export function prepareReport(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}
