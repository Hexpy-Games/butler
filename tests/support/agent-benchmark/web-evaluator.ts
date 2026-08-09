import type { BenchmarkFixture, EvaluationMetrics } from "./contracts.ts";

export function evaluateWebResearch(
  text: string | null,
  fixture: BenchmarkFixture,
): Pick<EvaluationMetrics, "factualAccuracy" | "sourceQuality" | "resultQuality" | "accepted" | "evaluatorNotes"> {
  const normalized = text?.toLowerCase() ?? "";
  const notes: string[] = [];
  const expectedSources = fixture.expectedSources ?? [];
  const predicates = [
    /bun\s*v?1\.3\.14\b/u,
    /(?:may\s+13,?\s+2026|2026-05-13|published[^.]{0,80}may\s+13\s+2026)/u,
    /built[- ]in\s+bun\.image\b/u,
    /(?:publication|published)[^.]{0,100}(?:event|release)\s+date|(?:event|release)\s+date[^.]{0,100}(?:publication|published)/u,
  ];
  const claimMatches = fixture.id === "current_web_research"
    ? predicates.filter((predicate) => predicate.test(normalized)).length
    : 0;
  const claimTotal = fixture.expectedClaims?.length ?? 0;
  const factualAccuracy = claimTotal > 0 ? claimMatches / claimTotal : null;
  const urls = text?.match(/https?:\/\/[^\s)\]}]+/gu) ?? [];
  const sourceMatches = expectedSources.filter((source) => normalized.includes(source.toLowerCase())).length;
  const sourceQuality = expectedSources.length > 0 ? sourceMatches / expectedSources.length : 0;
  if (sourceMatches !== expectedSources.length) notes.push("required-official-source-missing");
  if (urls.some((url) => !expectedSources.some((source) => url.startsWith(source)))) notes.push("unverified-source-url");
  const accepted = claimMatches === claimTotal && sourceQuality === 1 && notes.length === 0;
  return {
    accepted,
    factualAccuracy,
    sourceQuality,
    resultQuality: accepted ? 5 : Math.max(1, Math.round((factualAccuracy ?? 0) * 4)),
    evaluatorNotes: notes,
  };
}
