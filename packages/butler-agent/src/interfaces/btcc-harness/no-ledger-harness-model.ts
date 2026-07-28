import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";

type SelectedModel = BtccRuntimeDependencies["model"];
type PhaseEnvelope = Parameters<SelectedModel["runRound"]>[0];
type ProviderRoundValue = Awaited<ReturnType<SelectedModel["runRound"]>>;

export type NoLedgerScenario =
  | "direct-greeting"
  | "direct-translation"
  | "onboarding-local-effect"
  | "assisted-weather"
  | "assisted-research";

export class NoLedgerHarnessModel implements SelectedModel {
  callCount = 0;
  readonly phases: string[] = [];

  constructor(private readonly scenario: NoLedgerScenario) {}

  async runRound(envelope: PhaseEnvelope): Promise<ProviderRoundValue> {
    this.callCount += 1;
    this.phases.push(envelope.phase);
    return this.roundFor(envelope);
  }

  private roundFor(envelope: PhaseEnvelope): ProviderRoundValue {
    if (this.scenario === "onboarding-local-effect") {
      return localEffectAnswer(envelope);
    }
    if (
      envelope.phase === "conception_opening" &&
      isAssistedScenario(this.scenario)
    ) {
      return {
        kind: "phase_submission",
        submission: {
          kind: "assisted_continuation",
          requiredResultKind: "current_observation",
          requestObligation: outcomeFor(this.scenario),
          summary: "필요한 최신 정보를 확인하겠습니다.",
          rationale: "현재 상태를 확인해야 정확하게 답할 수 있습니다.",
          nextStep: "필요한 관찰만 수행한 뒤 바로 알려드리겠습니다.",
        },
        actualIdentity: identity(envelope),
      };
    }
    if (this.scenario === "assisted-weather" && envelope.operationResults.length === 0) {
      return operations(envelope, [{
        requestId: "observe-seoul-weather",
        publicTitle: "서울의 현재 날씨를 확인합니다",
        kind: "observe",
        capabilityRef: "weather:seoul-current",
        scopeRef: "public-current-information",
        input: { location: "서울" },
      }]);
    }
    if (this.scenario === "assisted-research" && envelope.operationResults.length < 2) {
      const ordinal = envelope.operationResults.length + 1;
      return operations(envelope, [{
        requestId: `observe-current-meme-${ordinal}`,
        publicTitle: `현재 유행 밈 자료 ${ordinal}을 확인합니다`,
        kind: "observe",
        capabilityRef: ordinal === 1 ? "meme:current-first" : "meme:current-second",
        scopeRef: "public-current-information",
        input: { query: `현재 유행 밈 ${ordinal}` },
      }]);
    }
    return answer(envelope, this.scenario);
  }
}

function localEffectAnswer(envelope: PhaseEnvelope): ProviderRoundValue {
  const personalizationApplications = [
    ...envelope.context.profileRefs,
    ...envelope.context.recentFeedbackRefs,
    ...envelope.context.mandatoryHotCacheRefs,
    ...envelope.context.optionalHotCacheRefs,
  ].map((ref) => ({ ref, decision: "applied" as const }));
  return {
    kind: "phase_submission",
    submission: {
      kind: "local_effect_answer",
      requiredResultKind: "turn_local_effect",
      effect: {
        capabilityRef: "update_onboarding_profile",
        publicTitle: "선호하는 응답 방식을 반영합니다",
        input: { profiling_mode: "deep", locale: "ko" },
      },
      requestObligation: outcomeFor("onboarding-local-effect"),
      interpretedIntent: intentFor("onboarding-local-effect"),
      requiredOutcome: outcomeFor("onboarding-local-effect"),
      requiredOutcomeResolution: "fulfilled",
      nonGoals: ["Work Ledger를 만들지 않는다"],
      answer: answerFor("onboarding-local-effect"),
      personalizationApplications,
      publicClaims: [],
    },
    actualIdentity: identity(envelope),
  };
}

function operations(
  envelope: PhaseEnvelope,
  requests: Extract<ProviderRoundValue, { kind: "operation_requests" }>["requests"],
): ProviderRoundValue {
  return { kind: "operation_requests", requests, actualIdentity: identity(envelope) };
}

function answer(envelope: PhaseEnvelope, scenario: NoLedgerScenario): ProviderRoundValue {
  const personalizationRefs = [
    ...envelope.context.profileRefs,
    ...envelope.context.recentFeedbackRefs,
    ...envelope.context.mandatoryHotCacheRefs,
    ...envelope.context.optionalHotCacheRefs,
  ];
  const personalizationApplications = personalizationRefs.map((ref) => ({
    ref,
    decision: "applied" as const,
  }));
  const claims = answerClaims(envelope, scenario);
  return {
    kind: "phase_submission",
    submission: {
      kind: isAssistedScenario(scenario) ? "assisted_answer" : "direct_answer",
      requiredResultKind: isAssistedScenario(scenario)
        ? "current_observation"
        : "response_content",
      requestObligation: outcomeFor(scenario),
      interpretedIntent: intentFor(scenario),
      requiredOutcome: outcomeFor(scenario),
      requiredOutcomeResolution: "fulfilled",
      nonGoals: ["관리 작업이나 Work Ledger를 만들지 않는다"],
      answer: answerFor(scenario),
      personalizationApplications,
      publicClaims: claims,
    },
    actualIdentity: identity(envelope),
  };
}

function answerClaims(envelope: PhaseEnvelope, scenario: NoLedgerScenario) {
  if (!isAssistedScenario(scenario)) return [];
  return envelope.operationResults.map((result) => ({
    claim: result.view?.content ?? result.preview,
    sourceRefs: [result.observationRef],
  }));
}

function isAssistedScenario(
  scenario: NoLedgerScenario,
): scenario is "assisted-weather" | "assisted-research" {
  return scenario === "assisted-weather" || scenario === "assisted-research";
}

function intentFor(scenario: NoLedgerScenario): string {
  switch (scenario) {
    case "direct-greeting": return "짧고 정중하게 인사한다";
    case "direct-translation": return "주어진 한국어 문장을 영어로 번역한다";
    case "onboarding-local-effect": return "확인된 심화 프로파일링 선호를 저장한다";
    case "assisted-weather": return "현재 서울 날씨를 확인해 전달한다";
    case "assisted-research": return "현재 유행하는 밈 두 가지를 찾아 요약한다";
  }
}

function outcomeFor(scenario: NoLedgerScenario): string {
  switch (scenario) {
    case "direct-greeting": return "개인화된 인사말을 전달한다";
    case "direct-translation": return "정확한 영어 번역문을 전달한다";
    case "onboarding-local-effect": return "심화 프로파일링 설정을 반영하고 다음 안내를 전달한다";
    case "assisted-weather": return "관찰한 현재 서울 날씨를 전달한다";
    case "assisted-research": return "관찰한 밈 두 가지를 짧게 전달한다";
  }
}

function answerFor(scenario: NoLedgerScenario): string {
  switch (scenario) {
    case "direct-greeting": return "안녕하세요. 오늘도 핵심부터 함께 보겠습니다.";
    case "direct-translation": return "Good morning.";
    case "onboarding-local-effect": return "심화 프로파일링으로 설정했습니다. 이제 온보딩을 마쳤어요.";
    case "assisted-weather": return "서울은 현재 맑고 24도입니다.";
    case "assisted-research": return "요즘은 직장인 고양이 밈과 예상 대 현실 형식이 눈에 띕니다.";
  }
}

function identity(envelope: PhaseEnvelope) {
  return {
    provider: envelope.modelSelection.provider,
    model: envelope.modelSelection.model,
    reasoningEffort: envelope.modelSelection.reasoningEffort,
    controlsHash: envelope.modelSelection.controlsHash,
  };
}
