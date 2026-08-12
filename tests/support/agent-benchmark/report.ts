import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BenchmarkAgent,
  BenchmarkObservation,
  BenchmarkResultFile,
  BenchmarkScenario,
} from "./contracts.ts";
import { sanitizeIdentifier } from "./identifiers.ts";
import type { M1V2CampaignResult } from "./m1-v2-types.ts";
import { m1V2ReportLines, summarizeM1V2Campaign } from "./m1-v2-report.ts";

export interface BenchmarkReportSummary {
  runId: string;
  baselineSha: string;
  seed: number;
  observationCount: number;
  acceptedCount: number;
  gatedAgents: BenchmarkAgent[];
  canRank: boolean;
  m1V2Campaign: M1V2CampaignResult | null;
  medians: Array<{
    agent: BenchmarkAgent;
    scenario: BenchmarkScenario;
    track: "controlled" | "recommended-default";
    cache: "cold" | "warm";
    accepted: number;
    totalTokens: number | null;
    elapsedMs: number | null;
    acceptedResultPerToken: number | null;
  }>;
  arms: Array<{
    key: string;
    agent: BenchmarkAgent;
    scenario: BenchmarkScenario;
    track: "controlled" | "recommended-default";
    cache: "cold" | "warm";
    terminalState: string;
    gateCode: string;
    inputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    modelRequests: number | null;
    toolCalls: number | null;
    toolFailures: number | null;
    firstUsefulLatencyMs: number | null;
    totalElapsedMs: number | null;
    userInterventions: number | null;
    retries: number | null;
    changedFiles: number | null;
    testsPassed: boolean | null;
    buildPassed: boolean | null;
    effectiveModel: string | null;
    adapterVersion: string | null;
    accepted: boolean | null;
    factualAccuracy: number | null;
    sourceQuality: number | null;
    visualQuality: number | null;
    visualReviewer: string | null;
    visualRubricVersion: string | null;
    resultQuality: number | null;
    acceptedResultPerToken: number | null;
  }>;
}

export function summarizeBenchmarkResult(result: BenchmarkResultFile): BenchmarkReportSummary {
  const observations = result.observations;
  const gatedAgents = [...new Set(
    observations.filter((observation) => observation.terminalState === "gated").map((observation) => observation.arm.agent),
  )];
  const groups = new Map<string, BenchmarkObservation[]>();
  for (const observation of observations) {
    const { agent, scenario, track, cache } = observation.arm;
    const key = `${agent}|${scenario}|${track}|${cache}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const medians = [...groups.entries()].map(([key, group]) => {
    const [agent, scenario, track, cache] = key.split("|") as [BenchmarkAgent, BenchmarkScenario, "controlled" | "recommended-default", "cold" | "warm"];
    const accepted = group.filter((observation) => observation.terminalState === "accepted").length;
    return {
      agent,
      scenario,
      track,
      cache,
      accepted,
      totalTokens: median(group.map((observation) => observation.usage.totalTokens)),
      elapsedMs: median(group.map((observation) => observation.timing.totalElapsedMs)),
      acceptedResultPerToken: median(group.map((observation) => observation.acceptedResultPerToken)),
    };
  });
  const requiredKeys = result.plan.arms.map((arm) => arm.key);
  const byKey = new Map(observations.map((observation) => [observation.arm.key, observation]));
  const complete = requiredKeys.every((key) => byKey.has(key));
  const requiredAgents: readonly BenchmarkAgent[] = ["butler", "hermes", "opencode"];
  const eligibleTrack = (track: "controlled" | "recommended-default"): boolean => result.plan.arms
    .filter((arm) => arm.track === track)
    .every((arm) => {
      const observation = byKey.get(arm.key);
      return observation?.terminalState === "accepted" && observation.evaluation.accepted === true &&
        observation.acceptedResultPerToken !== null && observation.usage.totalTokens !== null;
    });
  const visualReviewComplete = (track: "controlled" | "recommended-default"): boolean => result.plan.arms
    .filter((arm) => arm.track === track && arm.scenario === "butler_landing_page")
    .every((arm) => {
      const observation = byKey.get(arm.key);
      const score = observation?.evaluation.visualQuality;
      return observation?.visualReview !== null &&
        observation?.visualReview !== undefined &&
        typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= 5;
    });
  const hasAcceptedForEachAgentAndTrack = (result.plan.tracks ?? ["controlled", "recommended-default"]).every((track) =>
    requiredAgents.every((agent) => result.plan.arms.filter((arm) => arm.agent === agent && arm.track === track).every((arm) => {
      const observation = byKey.get(arm.key);
      return observation?.terminalState === "accepted" && observation.acceptedResultPerToken !== null && observation.usage.totalTokens !== null;
    })),
  );
  const arms = result.plan.arms.map((arm) => {
    const observation = byKey.get(arm.key);
    return {
      key: arm.key,
      agent: arm.agent,
      scenario: arm.scenario,
      track: arm.track,
      cache: arm.cache,
      terminalState: observation?.terminalState ?? "pending",
      gateCode: observation?.gateCode ?? "none",
      inputTokens: observation?.usage.inputTokens ?? null,
      cacheReadTokens: observation?.usage.cacheReadTokens ?? null,
      cacheWriteTokens: observation?.usage.cacheWriteTokens ?? null,
      outputTokens: observation?.usage.outputTokens ?? null,
      totalTokens: observation?.usage.totalTokens ?? null,
      modelRequests: observation?.usage.modelRequests ?? null,
      toolCalls: observation?.tools.calls ?? null,
      toolFailures: observation?.tools.failedCalls ?? null,
      firstUsefulLatencyMs: firstUsefulLatency(observation),
      totalElapsedMs: observation?.timing.totalElapsedMs ?? null,
      userInterventions: observation?.operations.userInterventions ?? null,
      retries: observation?.operations.retries ?? null,
      changedFiles: observation?.operations.changedFiles ?? null,
      testsPassed: observation?.operations.tests.passed ?? null,
      buildPassed: observation?.operations.build.passed ?? null,
      effectiveModel: observation?.effectiveConfig.model ?? null,
      adapterVersion: observation?.adapterVersion ?? null,
      accepted: observation?.evaluation.accepted ?? null,
      factualAccuracy: observation?.evaluation.factualAccuracy ?? null,
      sourceQuality: observation?.evaluation.sourceQuality ?? null,
      visualQuality: observation?.evaluation.visualQuality ?? null,
      visualReviewer: sanitizeIdentifier(observation?.visualReview?.reviewerLabel) ?? null,
      visualRubricVersion: sanitizeIdentifier(observation?.visualReview?.rubricVersion) ?? null,
      resultQuality: observation?.evaluation.resultQuality ?? null,
      acceptedResultPerToken: observation?.acceptedResultPerToken ?? null,
    };
  });
  return {
    runId: result.run.runId,
    baselineSha: result.run.baselineSha,
    seed: result.run.seed,
    observationCount: observations.length,
    acceptedCount: observations.filter((observation) => observation.terminalState === "accepted").length,
    gatedAgents,
    canRank: complete && [...(result.plan.tracks ?? ["controlled", "recommended-default"])].every((track) => eligibleTrack(track) && visualReviewComplete(track)) && hasAcceptedForEachAgentAndTrack && gatedAgents.length === 0,
    m1V2Campaign: summarizeM1V2Campaign(result),
    arms,
    medians,
  };
}

export function generateBenchmarkReport(result: BenchmarkResultFile): string {
  const summary = summarizeBenchmarkResult(result);
  const lines = [
    "# Butler agent benchmark pilot",
    "",
    "This report is generated from the persisted benchmark observations. It does not contain prompts, transcripts, credentials, tool payloads, hidden reasoning, or private absolute paths.",
    "",
    `- Schema: \`${result.schema}\``,
    `- Run: \`${summary.runId}\``,
    `- Baseline: \`${summary.baselineSha}\``,
    `- Seed: \`${summary.seed}\``,
    `- Observations: ${summary.observationCount}`,
    `- Accepted: ${summary.acceptedCount}`,
    `- Ranking: ${summary.canRank ? "eligible" : rankingStatus(summary)}`,
    "",
    "## Track configurations",
    "",
    `- Controlled: ${describeTrack(result, "controlled")}`,
    `- Recommended-default: ${describeTrack(result, "recommended-default")}`,
    "",
    "## Gates",
    "",
  ];
  const gates = result.observations.filter((observation) => observation.terminalState === "gated");
  if (gates.length === 0) lines.push("No adapter gates were recorded.");
  else {
    for (const observation of gates) {
      lines.push(`- ${observation.arm.agent} / ${observation.arm.scenario} / ${observation.arm.track} / ${observation.arm.cache}: \`${observation.gateCode}\``);
    }
  }
  lines.push("", "## Per-arm metrics", "", "| Agent | Track | Scenario | Cache | State | Gate | Input | Cache read | Cache write | Output | Total | Requests | Tools | Tool failures | First useful latency ms | Elapsed ms | Interventions | Retries | Changed files | Tests | Build | Effective model | Adapter | Factual | Sources | Visual | Reviewer | Rubric | Result | Accepted / 1M tokens |", "| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: |");
  for (const arm of summary.arms) {
    lines.push(`| ${arm.agent} | ${arm.track} | ${arm.scenario} | ${arm.cache} | ${arm.terminalState} | ${arm.gateCode} | ${formatNumber(arm.inputTokens)} | ${formatNumber(arm.cacheReadTokens)} | ${formatNumber(arm.cacheWriteTokens)} | ${formatNumber(arm.outputTokens)} | ${formatNumber(arm.totalTokens)} | ${formatNumber(arm.modelRequests)} | ${formatNumber(arm.toolCalls)} | ${formatNumber(arm.toolFailures)} | ${formatNumber(arm.firstUsefulLatencyMs)} | ${formatNumber(arm.totalElapsedMs)} | ${formatNumber(arm.userInterventions)} | ${formatNumber(arm.retries)} | ${formatNumber(arm.changedFiles)} | ${formatBoolean(arm.testsPassed)} | ${formatBoolean(arm.buildPassed)} | ${arm.effectiveModel ?? "—"} | ${arm.adapterVersion ?? "—"} | ${formatNumber(arm.factualAccuracy)} | ${formatNumber(arm.sourceQuality)} | ${formatNumber(arm.visualQuality)} | ${arm.visualReviewer ?? "—"} | ${arm.visualRubricVersion ?? "—"} | ${formatNumber(arm.resultQuality)} | ${formatNumber(arm.acceptedResultPerToken)} |`);
  }
  lines.push("", "## Per-group medians", "", "| Agent | Track | Scenario | Cache | Accepted | Total tokens | Elapsed ms | Accepted result / 1M tokens |", "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const median of summary.medians) {
    lines.push(`| ${median.agent} | ${median.track} | ${median.scenario} | ${median.cache} | ${median.accepted} | ${formatNumber(median.totalTokens)} | ${formatNumber(median.elapsedMs)} | ${formatNumber(median.acceptedResultPerToken)} |`);
  }
  lines.push(
    "",
    "## Interpretation",
    "",
    summary.canRank
      ? "All required agents have eligible observations. Comparisons remain stratified by track, scenario, and cache arm."
      : rankingInterpretation(summary),
    "",
    "See `PILOT_PROTOCOL.md` for the operator protocol and official installation links.",
    "",
  );
  lines.push(...m1V2ReportLines(summary.m1V2Campaign));
  return lines.join("\n");
}

function rankingStatus(summary: BenchmarkReportSummary): string {
  const missing = summary.arms.some((arm) => arm.terminalState === "pending");
  const gated = summary.gatedAgents.length > 0 || summary.arms.some((arm) => arm.gateCode !== "none");
  if (missing && gated) return "withheld (missing or gated observations)";
  if (missing) return "withheld (missing observations)";
  if (gated) return "withheld (gated observations)";
  if (summary.acceptedCount === 0) return "withheld (no observation met acceptance criteria)";
  return "withheld (required metrics or visual review incomplete)";
}

function rankingInterpretation(summary: BenchmarkReportSummary): string {
  const missing = summary.arms.some((arm) => arm.terminalState === "pending");
  const gated = summary.gatedAgents.length > 0 || summary.arms.some((arm) => arm.gateCode !== "none");
  if (missing && gated) return "Required observations are missing or gated. No agent ranking or fabricated comparison number is reported.";
  if (missing) return "Required observations are missing. No agent ranking or fabricated comparison number is reported.";
  if (gated) return "One or more required observations are gated. No agent ranking or fabricated comparison number is reported.";
  if (summary.acceptedCount === 0) return "No observation met the acceptance criteria. No agent ranking or accepted-result-per-token comparison is reported.";
  return "Observations completed, but required token metrics, visual review, or other eligibility evidence is incomplete. No agent ranking or fabricated comparison number is reported.";
}

export function writeBenchmarkReport(
  result: BenchmarkResultFile,
  outputDirectory: string,
): { markdownPath: string; jsonPath: string } {
  mkdirSync(outputDirectory, { recursive: true });
  const markdownPath = join(outputDirectory, "agent-benchmark-report.md");
  const jsonPath = join(outputDirectory, "agent-benchmark-summary.json");
  writeFileSync(markdownPath, generateBenchmarkReport(result), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(summarizeBenchmarkResult(result), null, 2)}\n`, "utf8");
  return { markdownPath, jsonPath };
}

function median(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 1 ? finite[middle]! : (finite[middle - 1]! + finite[middle]!) / 2;
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatBoolean(value: boolean | null): string {
  return value === null ? "—" : value ? "pass" : "fail";
}

function describeTrack(result: BenchmarkResultFile, track: "controlled" | "recommended-default"): string {
  const agents: BenchmarkAgent[] = ["butler", "hermes", "opencode"];
  const descriptions = agents.map((agent) => {
    const arm = result.plan.arms.find((candidate) => candidate.track === track && candidate.agent === agent);
    if (!arm) return `${agent}: not present`;
    const observation = result.observations.find((candidate) => candidate.arm.key === arm.key);
    const config = observation?.effectiveConfig ?? arm.effectiveConfig;
    const model = sanitizeIdentifier(config.model) ?? "product-resolved";
    const reasoning = sanitizeIdentifier(config.reasoning) ?? "product-resolved";
    const permissions = sanitizeIdentifier(config.permissions) ?? "unavailable";
    const tools = config.tools.map((tool) => sanitizeIdentifier(tool)).filter((tool): tool is string => tool !== null).join(",") || "unavailable";
    const provider = sanitizeIdentifier(config.provider) ?? "product-resolved";
    return `${agent}: model=${model}, reasoning=${reasoning}, provider=${provider}, permissions=${permissions}, tools=${tools}`;
  });
  return descriptions.join("; ");
}

function firstUsefulLatency(observation: BenchmarkObservation | undefined): number | null {
  const submitted = observation?.timing.submittedAtMs;
  const useful = observation?.timing.firstUsefulOutputAtMs;
  if (typeof submitted !== "number" || typeof useful !== "number" || useful < submitted) return null;
  return useful - submitted;
}
