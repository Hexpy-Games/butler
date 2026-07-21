import type { PhaseEnvelope } from "../../core/index.ts";
import type {
  ButlerContextResolver,
  RenderedPhasePrompt,
  ResolvedContextDocument,
  StructuralCapabilityCatalog,
} from "./contracts.ts";
import { resolveAvailableCapabilities } from "./available-capabilities.ts";
import { providerCarrierSchema } from "./provider-carrier-schema.ts";
import { providerCarrierFunctions } from "./provider-carrier-schema.ts";

export async function renderPhasePrompt(
  envelope: PhaseEnvelope,
  contextResolver: ButlerContextResolver,
  capabilityCatalog: StructuralCapabilityCatalog,
): Promise<RenderedPhasePrompt> {
  const [resolvedContext, availableCapabilities] = await Promise.all([
    resolveButlerContext(envelope, contextResolver),
    resolveAvailableCapabilities({
      authority: envelope.operationAuthority,
      catalog: capabilityCatalog,
    }),
  ]);
  return {
    instructions: [
      "Return exactly one BTCC provider carrier matching the supplied JSON schema.",
      "Do not add prose outside the carrier and do not choose a successor phase or model.",
      "Choose semantic operations only; the runtime binds immutable authority references.",
    ].join(" "),
    prompt: JSON.stringify({
      binding: envelope.binding,
      selectedModel: envelope.modelSelection,
      phaseContract: exactPhaseContract(envelope),
      stateInput: envelope.context.stateInput ?? null,
      originalRequest: {
        messageId: envelope.context.originalMessageId,
        content: envelope.context.originalMessage,
      },
      butlerContext: {
        sessionId: envelope.context.sessionId,
        userRef: envelope.context.userRef,
        projectRef: envelope.context.projectRef ?? null,
        profile: resolvedContext.profile,
        recentFeedback: resolvedContext.recentFeedback,
        mandatoryHotCache: resolvedContext.mandatoryHotCache,
        optionalHotCache: resolvedContext.optionalHotCache,
        continuationCandidates: envelope.context.continuationCandidates ?? [],
        baselineObservationScopeRefs: envelope.context.baselineObservationScopeRefs,
      },
      priorOperationResults: envelope.operationResults,
      operationAuthority: envelope.operationAuthority,
      availableCapabilities,
      outputSchemaGuidance: {
        carrierKinds: ["phase_submission", "operation_requests"],
        phaseSubmission: "Use one submission object allowed by the exact phase exits.",
        operationRequests: "Use a non-empty array of typed requests within authority.",
      },
    }),
    responseSchema: providerCarrierSchema(
      availableCapabilities,
      envelope.submissionSchema,
    ),
    carrierFunctions: providerCarrierFunctions(
      availableCapabilities,
      envelope.submissionSchema,
    ),
  };
}

function exactPhaseContract(envelope: PhaseEnvelope) {
  return {
    phase: envelope.phase,
    objective: envelope.objective,
    duties: envelope.duties,
    prohibitions: envelope.prohibitions,
    ...(envelope.exitDuties ? { exitDuties: envelope.exitDuties } : {}),
    ...(envelope.authoringContractRefs
      ? { authoringContractRefs: envelope.authoringContractRefs }
      : {}),
    ...(envelope.authoringContracts
      ? { authoringContracts: envelope.authoringContracts }
      : {}),
  };
}

async function resolveButlerContext(
  envelope: PhaseEnvelope,
  resolver: ButlerContextResolver,
) {
  return {
    profile: await resolveDocuments(envelope.context.profileRefs, resolver),
    recentFeedback: await resolveDocuments(envelope.context.recentFeedbackRefs, resolver),
    mandatoryHotCache: await resolveDocuments(envelope.context.mandatoryHotCacheRefs, resolver),
    optionalHotCache: await resolveDocuments(envelope.context.optionalHotCacheRefs, resolver),
  };
}

async function resolveDocuments(
  refs: readonly string[],
  resolver: ButlerContextResolver,
): Promise<ResolvedContextDocument[]> {
  return await Promise.all(refs.map(async (ref) => ({
    ref,
    content: await resolver.resolve(ref),
  })));
}
