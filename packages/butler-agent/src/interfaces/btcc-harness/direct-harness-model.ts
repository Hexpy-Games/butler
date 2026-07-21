import type {
  BtccRuntimeDependencies,
} from "../../agent/btcc/index.ts";

type SelectedModel = BtccRuntimeDependencies["model"];
type PhaseEnvelope = Parameters<SelectedModel["runRound"]>[0];
type ProviderRoundValue = Awaited<ReturnType<SelectedModel["runRound"]>>;

export class DirectHarnessModel implements SelectedModel {
  callCount = 0;

  async runRound(envelope: PhaseEnvelope): Promise<ProviderRoundValue> {
    this.callCount += 1;
    const personalizationRefs = [
      ...envelope.context.profileRefs,
      ...envelope.context.recentFeedbackRefs,
      ...envelope.context.mandatoryHotCacheRefs,
      ...envelope.context.optionalHotCacheRefs,
    ];
    const personalizationApplications = personalizationRefs.map((ref) => ({
      ref,
      decision: "applied",
    }));
    return {
      kind: "phase_submission",
      submission: {
        kind: "direct_answer",
        interpretedIntent: "사용자에게 짧고 정중하게 인사한다",
        requiredOutcome: "짧은 인사말을 전달한다",
        requiredOutcomeResolution: "fulfilled",
        nonGoals: ["관리 작업이나 Work Ledger를 만들지 않는다"],
        answer: "안녕하세요. 반갑습니다.",
        personalizationApplications,
        guard: {
          responseVerdict: "responsive",
          personalizationVerdicts: personalizationApplications.map(({ ref }) => ({
            ref,
            verdict: "faithful_and_public_safe",
          })),
          verdict: "accepted",
        },
      },
      actualIdentity: {
        provider: envelope.modelSelection.provider,
        model: envelope.modelSelection.model,
        reasoningEffort: envelope.modelSelection.reasoningEffort,
        controlsHash: envelope.modelSelection.controlsHash,
      },
    };
  }
}
