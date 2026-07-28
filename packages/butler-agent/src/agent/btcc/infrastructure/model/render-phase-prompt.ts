import type { OperationRequest, PhaseEnvelope } from "../../core/index.ts";
import { modelStructuredDecisionTransport } from
  "../../../../integrations/providers/model-catalog.ts";
import type {
  ButlerContextResolver,
  AvailablePhaseCapability,
  RenderedPhasePrompt,
  ResolvedContextDocument,
  StructuralCapabilityCatalog,
} from "./contracts.ts";
import { resolvePhaseCapabilities } from "./available-capabilities.ts";
import {
  providerCarrierAdmissionSchema,
  providerCarrierSchema,
} from "./provider-carrier-schema.ts";
import { providerCarrierFunctions } from "./provider-carrier-schema.ts";
import type { PhaseGuidanceReader } from "../../guidance/index.ts";
import {
  projectOperationContext,
} from "./project-operation-context.ts";
import { fitOperationContext } from "./fit-operation-context.ts";
import { renderCacheOrderedPhasePrompt } from "./phase-prompt-document.ts";

export async function renderPhasePrompt(
  envelope: PhaseEnvelope,
  contextResolver: ButlerContextResolver,
  capabilityCatalog: StructuralCapabilityCatalog,
  guidanceReader: PhaseGuidanceReader,
): Promise<RenderedPhasePrompt> {
  const operationAuthority = envelope.operationAuthority;
  const [resolvedContext, capabilitySurface, acceptedPhaseGuidance] = await Promise.all([
    resolveButlerContext(envelope, contextResolver),
    resolvePhaseCapabilities({
      authority: operationAuthority,
      catalog: capabilityCatalog,
    }),
    guidanceReader.list({
      phase: envelope.phase,
      userRef: envelope.context.userRef,
      sessionId: envelope.context.sessionId,
      ...(envelope.context.projectRef ? { projectRef: envelope.context.projectRef } : {}),
    }),
  ]);
  const availableCapabilities = capabilitySurface.availableCapabilities;
  assertRequiredMutationCapability(operationAuthority, availableCapabilities);
  const providerVocabulary = envelope.operationSurface === "closed"
    ? []
    : capabilitySurface.providerVocabulary;
  const responseSchema = providerCarrierSchema(
    providerVocabulary,
    envelope.submissionSchema,
  );
  const carrierAdmissionSchema = providerCarrierAdmissionSchema(
    providerVocabulary,
    availableCapabilities,
    envelope.submissionSchema,
    operationAuthority,
  );
  const carrierFunctions = providerCarrierFunctions(
    providerVocabulary,
    envelope.submissionSchema,
  );
  const instructions = [
    "Return exactly one BTCC provider carrier matching the supplied JSON schema.",
    "Do not add prose outside the carrier and do not choose a successor phase or model.",
    "Choose only operations listed in the current capabilitySchemas.",
    "For observe, select its required scopeRef from that capability's observationScopeRefs.",
    "The runtime binds mutation, validation, effect, and promotion authority references.",
    "Read the stablePhasePrefix JSON document before the dynamicTurnContent document.",
    "Within the stable promptHierarchy, earlier layers override later layers.",
  ].join(" ");
  const projectedOperationContext = projectOperationContext(envelope);
  const renderPrompt = (
    operationContext: typeof projectedOperationContext,
  ) => renderCacheOrderedPhasePrompt({
    envelope,
    resolvedContext,
    availableCapabilities,
    acceptedPhaseGuidance,
    operationAuthority,
    operationContext,
  }).prompt;
  const operationContext = fitOperationContext({
    projected: projectedOperationContext,
    modelSelection: envelope.modelSelection,
    renderPrompt,
    fixedRequestShape: fixedProviderRequestShape(
      envelope,
      instructions,
      responseSchema,
      carrierFunctions,
    ),
  });
  const renderedPrompt = renderCacheOrderedPhasePrompt({
    envelope,
    resolvedContext,
    availableCapabilities,
    acceptedPhaseGuidance,
    operationAuthority,
    operationContext,
  });
  return {
    instructions,
    ...renderedPrompt,
    responseSchema,
    carrierAdmissionSchema,
    carrierFunctions,
  };
}

function assertRequiredMutationCapability(
  authority: PhaseEnvelope["operationAuthority"],
  capabilities: readonly AvailablePhaseCapability[],
): void {
  const required = requiredMutationOperation(authority.mutation);
  if (!required || capabilities.some((item) => item.operationKind === required)) return;
  throw new Error(`required_mutation_capability_unavailable:${required}`);
}

function requiredMutationOperation(
  mutation: PhaseEnvelope["operationAuthority"]["mutation"],
): OperationRequest["kind"] | undefined {
  if (mutation.kind === "external_effect_only") return "external_effect";
  if (mutation.kind === "turn_local_effect_only") return "turn_local_effect";
  if (mutation.kind === "repository_promotion_only") return "repository_promotion";
  if (mutation.kind === "validation_overlay_only") return "review_validation";
  if (
    mutation.kind === "workspace_only" &&
    mutation.mutationScope.kind === "contained_paths"
  ) return "workspace_artifact_action";
  return undefined;
}

function fixedProviderRequestShape(
  envelope: PhaseEnvelope,
  instructions: string,
  responseSchema: Record<string, unknown>,
  carrierFunctions: ReturnType<typeof providerCarrierFunctions>,
) {
  const selected = envelope.modelSelection;
  const modelRef = selected.model.includes("/")
    ? selected.model
    : `${selected.provider}/${selected.model}`;
  return modelStructuredDecisionTransport(modelRef) === "function_tool"
    ? { instructions, carrierFunctions }
    : { instructions, responseSchema };
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
