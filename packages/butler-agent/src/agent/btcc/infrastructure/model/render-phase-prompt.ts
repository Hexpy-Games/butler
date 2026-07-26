import type { PhaseEnvelope } from "../../core/index.ts";
import { modelStructuredDecisionTransport } from
  "../../../../integrations/providers/model-catalog.ts";
import type {
  ButlerContextResolver,
  RenderedPhasePrompt,
  ResolvedContextDocument,
  StructuralCapabilityCatalog,
} from "./contracts.ts";
import { resolveAvailableCapabilities } from "./available-capabilities.ts";
import { providerCarrierSchema } from "./provider-carrier-schema.ts";
import { providerCarrierFunctions } from "./provider-carrier-schema.ts";
import { providerCarrierAdmissionSchema } from "./provider-carrier-schema.ts";
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
  const operationAuthority = envelope.operationSurface === "closed"
    ? {
        observationScopeRefs: [],
        mutation: { kind: "forbidden" as const },
      }
    : envelope.operationAuthority;
  const [resolvedContext, availableCapabilities, acceptedPhaseGuidance] = await Promise.all([
    resolveButlerContext(envelope, contextResolver),
    resolveAvailableCapabilities({
      authority: operationAuthority,
      catalog: capabilityCatalog,
    }),
    guidanceReader.list({
      phase: envelope.phase,
      userRef: envelope.context.userRef,
      ...(envelope.context.projectRef ? { projectRef: envelope.context.projectRef } : {}),
    }),
  ]);
  const responseSchema = providerCarrierSchema(
    availableCapabilities,
    envelope.submissionSchema,
    operationAuthority,
  );
  const carrierFunctions = providerCarrierFunctions(
    availableCapabilities,
    envelope.submissionSchema,
    operationAuthority,
  );
  const instructions = [
    "Return exactly one BTCC provider carrier matching the supplied JSON schema.",
    "Do not add prose outside the carrier and do not choose a successor phase or model.",
    "Choose semantic operations only; the runtime binds immutable authority references.",
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
  });
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
  return {
    instructions,
    prompt: renderPrompt(operationContext),
    responseSchema,
    carrierFunctions,
    admissionSchema: providerCarrierAdmissionSchema(
      availableCapabilities,
      envelope.submissionSchema,
    ),
  };
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
