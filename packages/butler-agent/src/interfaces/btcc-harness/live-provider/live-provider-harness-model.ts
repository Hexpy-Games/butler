import type { BtccRuntimeDependencies } from "../../../agent/btcc/index.ts";
import { modelStructuredDecisionTransport } from "../../../integrations/providers/model-catalog.ts";
import { parseModelRef } from "../../../integrations/providers/model-ref.ts";
import {
  runFunctionToolPromptText,
  runPromptTextWithUsage,
} from "../../../integrations/providers/runtime.ts";
import {
  assertStructuralSubmission,
  bindStructuralSubmission,
  structuralSubmissionSchema,
} from "./structural-submission.ts";

type SelectedModel = BtccRuntimeDependencies["model"];
type PhaseEnvelope = Parameters<SelectedModel["runRound"]>[0];
type ProviderRound = Awaited<ReturnType<SelectedModel["runRound"]>>;
type CommonPrompt = Pick<
  Parameters<typeof runFunctionToolPromptText>[0],
  "model" | "reasoningEffort" | "signal" | "cacheScope" | "instructions" | "prompt"
>;

export class LiveProviderHarnessModel implements SelectedModel {
  callCount = 0;
  providerCallCount = 0;
  readonly phases: string[] = [];

  constructor(
    private readonly structuralAuthor: SelectedModel,
    private readonly trace: (entry: { phase: string; submission: unknown }) => void = () => {},
  ) {}

  async runRound(envelope: PhaseEnvelope, signal?: AbortSignal): Promise<ProviderRound> {
    this.callCount += 1;
    this.phases.push(envelope.phase);
    const template = await this.structuralAuthor.runRound(envelope, signal);
    if (template.kind === "interruption") {
      return template;
    }
    const structuralTemplate = template.kind === "phase_submission"
      ? template.submission
      : {
          kind: "operation_requests",
          phaseContinuity: template.phaseContinuity,
          requests: template.requests,
        };
    try {
      return await this.authorValidCarrier(
        envelope,
        structuralTemplate,
        template.kind,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        kind: "interruption",
        code: interruptionCode(error),
        activation: { kind: "runtime_remediation" },
      };
    }
  }

  private async authorValidCarrier(
    envelope: PhaseEnvelope,
    template: unknown,
    carrierKind: "phase_submission" | "operation_requests",
    signal?: AbortSignal,
  ): Promise<ProviderRound> {
    this.providerCallCount += 1;
    const decoded = await requestStructuredSubmission(envelope, template, signal);
    if (!decoded || typeof decoded.submission !== "object" || !decoded.submission) {
      throw new Error("submission must be one non-null JSON object");
    }
    const submission = bindStructuralSubmission(template, decoded.submission);
    assertStructuralSubmission(template, submission);
    this.trace({ phase: envelope.phase, submission });
    if (carrierKind === "operation_requests") {
      const carrier = submission as {
        kind: "operation_requests";
        phaseContinuity?: Extract<
          ProviderRound,
          { kind: "operation_requests" }
        >["phaseContinuity"];
        requests: Extract<ProviderRound, { kind: "operation_requests" }>["requests"];
      };
      return {
        kind: "operation_requests",
        phaseContinuity: carrier.phaseContinuity,
        requests: carrier.requests,
        actualIdentity: actualIdentity(envelope),
      };
    }
    return {
      kind: "phase_submission",
      submission,
      actualIdentity: actualIdentity(envelope),
    };
  }
}

async function requestStructuredSubmission(
  envelope: PhaseEnvelope,
  template: unknown,
  signal?: AbortSignal,
): Promise<{ submission?: unknown }> {
  const model = selectedModelRef(envelope);
  const common = {
    model,
    reasoningEffort: envelope.modelSelection.reasoningEffort,
    signal,
    cacheScope: `btcc-live:${envelope.phase}`,
    instructions: livePhaseInstructions(),
    prompt: livePhasePrompt(envelope, template),
  } as const;
  const transport = modelStructuredDecisionTransport(model);
  if (transport === "json_schema") {
    const result = await runPromptTextWithUsage({
      ...common,
      responseFormat: {
        type: "json_schema",
        name: "btcc_phase_submission",
        schema: structuralSubmissionSchema(template),
        strict: true,
      },
    });
    assertActualModel(envelope, result.model);
    return JSON.parse(result.text) as { submission?: unknown };
  }
  if (transport !== "function_tool") {
    throw new Error(`structured_transport_unavailable:${model}`);
  }
  return requestFunctionSubmission(envelope, template, common);
}

async function requestFunctionSubmission(
  envelope: PhaseEnvelope,
  template: unknown,
  common: CommonPrompt,
): Promise<{ submission?: unknown }> {
  let submitted: unknown;
  await runFunctionToolPromptText({
    ...common,
    tools: [{
      type: "function",
      name: "submit_btcc_phase",
      description: "Submit the one structured product for the current BTCC phase.",
      parameters: structuralSubmissionSchema(template),
    }],
    toolChoice: "required",
    maxToolRounds: 1,
    executeTool(call) {
      submitted = call.args.submission;
      return Promise.resolve({ accepted: true });
    },
    finalTextFromToolResult() {
      return JSON.stringify({ submission: submitted });
    },
  });
  assertConfiguredModel(envelope, selectedModelRef(envelope));
  return { submission: submitted };
}

function livePhaseInstructions(): string {
  return [
    "You are the selected Butler BTCC phase model.",
    "Return only the JSON object required by the response schema.",
    "The structural template is valid for the exact persisted state.",
    "Preserve its kind, ids, refs, dependency keys, ordinals, and object shape.",
    "Author the semantic text for the original user request and current phase duties.",
    "Do not choose another phase, model, or runtime action.",
  ].join("\n");
}

function livePhasePrompt(
  envelope: PhaseEnvelope,
  template: unknown,
): string {
  return JSON.stringify({
    phase: envelope.phase,
    objective: envelope.objective,
    duties: envelope.duties,
    prohibitions: envelope.prohibitions,
    originalMessage: envelope.context.originalMessage,
    profileRefs: envelope.context.profileRefs,
    recentFeedbackRefs: envelope.context.recentFeedbackRefs,
    mandatoryHotCacheRefs: envelope.context.mandatoryHotCacheRefs,
    stateInput: envelope.context.stateInput,
    operationResults: envelope.operationResults,
    structuralTemplate: template,
    requiredOutput: { submission: "one structurally identical, semantically faithful object" },
  });
}

function actualIdentity(envelope: PhaseEnvelope) {
  return {
    provider: envelope.modelSelection.provider,
    model: envelope.modelSelection.model,
    reasoningEffort: envelope.modelSelection.reasoningEffort,
    controlsHash: envelope.modelSelection.controlsHash,
  };
}

function selectedModelRef(envelope: PhaseEnvelope): string {
  const selected = envelope.modelSelection.model;
  return selected.includes("/") ? selected : `${envelope.modelSelection.provider}/${selected}`;
}

function assertActualModel(envelope: PhaseEnvelope, actualModel: string): void {
  const selected = parseModelRef(selectedModelRef(envelope)).canonicalRef;
  const actual = parseModelRef(actualModel).canonicalRef;
  if (actual !== selected) throw new Error(`selected_actual_model_mismatch:${selected}:${actual}`);
}

function assertConfiguredModel(envelope: PhaseEnvelope, configuredModel: string): void {
  const selected = parseModelRef(selectedModelRef(envelope)).canonicalRef;
  const configured = parseModelRef(configuredModel).canonicalRef;
  if (configured !== selected) {
    throw new Error(`selected_configured_model_mismatch:${selected}:${configured}`);
  }
}

function interruptionCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error && typeof error === "object" && "causeMessage" in error
    ? String(error.causeMessage)
    : "";
  return `provider_interruption:${`${message} ${cause}`.trim().slice(0, 500)}`;
}
