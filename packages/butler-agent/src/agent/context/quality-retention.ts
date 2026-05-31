import { estimateContextTokens } from "./budget.ts";

export interface QualityFact {
  id: string;
  description: string;
  evidenceTerms: string[];
  answerTerms?: string[];
}

export interface QualityFixture {
  id: string;
  query: string;
  fullContext: string;
  compactContext: string;
  requiredFacts: QualityFact[];
  forbiddenFacts?: QualityFact[];
}

export interface AnswerQualityScore {
  requiredTotal: number;
  requiredCovered: number;
  requiredCoverage: number;
  forbiddenHits: string[];
  score: number;
}

export interface QualityTradeoffResult {
  fixtureId: string;
  fullTokens: number;
  compactTokens: number;
  tokenReductionRatio: number;
  fullAnswer: string;
  compactAnswer: string;
  fullQuality: AnswerQualityScore;
  compactQuality: AnswerQualityScore;
  qualityRetentionRatio: number;
}

export interface OptionalModelJudgeInput {
  fixture: QualityFixture;
  deterministic: QualityTradeoffResult;
}

export interface OptionalModelJudgeOutput {
  score: number;
  rationale: string;
  risks: string[];
}

export type OptionalModelQualityJudge =
  (input: OptionalModelJudgeInput) => Promise<OptionalModelJudgeOutput> | OptionalModelJudgeOutput;

export type OptionalModelJudgedQualityResult =
  | {
      available: false;
      reason: "judge_not_configured";
    }
  | {
      available: true;
      score: number;
      rationale: string;
      risks: string[];
      deterministic: {
        fixtureId: string;
        qualityRetentionRatio: number;
        tokenReductionRatio: number;
        compactForbiddenHits: string[];
      };
    };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsAllTerms(text: string, terms: string[]): boolean {
  const normalized = normalize(text);
  return terms.every((term) => normalized.includes(normalize(term)));
}

function factAnswerTerms(fact: QualityFact): string[] {
  return fact.answerTerms && fact.answerTerms.length > 0
    ? fact.answerTerms
    : fact.evidenceTerms;
}

export function synthesizeEvidenceAnswer(context: string, fixture: QualityFixture): string {
  const lines = [`Query: ${fixture.query}`];
  const supported = fixture.requiredFacts.filter((fact) => containsAllTerms(context, fact.evidenceTerms));
  if (supported.length === 0) {
    lines.push("No sufficient evidence in the provided context.");
    return lines.join("\n");
  }

  lines.push("Supported answer facts:");
  for (const fact of supported) {
    lines.push(`- ${fact.id}: ${fact.description}`);
  }
  return lines.join("\n");
}

export function evaluateAnswerQuality(answer: string, fixture: QualityFixture): AnswerQualityScore {
  const coveredFacts = fixture.requiredFacts.filter((fact) => containsAllTerms(answer, factAnswerTerms(fact)));
  const forbiddenHits = (fixture.forbiddenFacts ?? [])
    .filter((fact) => containsAllTerms(answer, factAnswerTerms(fact)))
    .map((fact) => fact.id);
  const requiredTotal = fixture.requiredFacts.length;
  const requiredCovered = coveredFacts.length;
  const requiredCoverage = requiredTotal > 0 ? requiredCovered / requiredTotal : 1;
  const forbiddenPenalty = forbiddenHits.length > 0 ? Math.min(1, forbiddenHits.length / Math.max(1, requiredTotal)) : 0;

  return {
    requiredTotal,
    requiredCovered,
    requiredCoverage,
    forbiddenHits,
    score: Math.max(0, requiredCoverage - forbiddenPenalty),
  };
}

export function evaluateQualityTradeoff(fixture: QualityFixture): QualityTradeoffResult {
  const fullAnswer = synthesizeEvidenceAnswer(fixture.fullContext, fixture);
  const compactAnswer = synthesizeEvidenceAnswer(fixture.compactContext, fixture);
  const fullQuality = evaluateAnswerQuality(fullAnswer, fixture);
  const compactQuality = evaluateAnswerQuality(compactAnswer, fixture);
  const fullTokens = estimateContextTokens(fixture.fullContext);
  const compactTokens = estimateContextTokens(fixture.compactContext);

  return {
    fixtureId: fixture.id,
    fullTokens,
    compactTokens,
    tokenReductionRatio: fullTokens > 0 ? 1 - (compactTokens / fullTokens) : 0,
    fullAnswer,
    compactAnswer,
    fullQuality,
    compactQuality,
    qualityRetentionRatio: fullQuality.score > 0 ? Math.min(1, compactQuality.score / fullQuality.score) : 1,
  };
}

export function summarizeQualityTradeoffs(results: QualityTradeoffResult[]): {
  fixtureCount: number;
  averageTokenReductionRatio: number;
  averageQualityRetentionRatio: number;
  minimumQualityRetentionRatio: number;
  totalForbiddenHits: number;
} {
  if (results.length === 0) {
    return {
      fixtureCount: 0,
      averageTokenReductionRatio: 0,
      averageQualityRetentionRatio: 0,
      minimumQualityRetentionRatio: 0,
      totalForbiddenHits: 0,
    };
  }

  return {
    fixtureCount: results.length,
    averageTokenReductionRatio:
      results.reduce((sum, result) => sum + result.tokenReductionRatio, 0) / results.length,
    averageQualityRetentionRatio:
      results.reduce((sum, result) => sum + result.qualityRetentionRatio, 0) / results.length,
    minimumQualityRetentionRatio:
      Math.min(...results.map((result) => result.qualityRetentionRatio)),
    totalForbiddenHits:
      results.reduce((sum, result) => sum + result.compactQuality.forbiddenHits.length, 0),
  };
}

export async function evaluateOptionalModelJudgedQuality(input: {
  fixture: QualityFixture;
  deterministic?: QualityTradeoffResult;
  judge?: OptionalModelQualityJudge;
}): Promise<OptionalModelJudgedQualityResult> {
  if (!input.judge) {
    return {
      available: false,
      reason: "judge_not_configured",
    };
  }
  const deterministic = input.deterministic ?? evaluateQualityTradeoff(input.fixture);
  const judged = await input.judge({
    fixture: input.fixture,
    deterministic,
  });
  return {
    available: true,
    score: Math.max(0, Math.min(1, judged.score)),
    rationale: judged.rationale,
    risks: judged.risks,
    deterministic: {
      fixtureId: deterministic.fixtureId,
      qualityRetentionRatio: deterministic.qualityRetentionRatio,
      tokenReductionRatio: deterministic.tokenReductionRatio,
      compactForbiddenHits: deterministic.compactQuality.forbiddenHits,
    },
  };
}
