import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  recallMemory,
  recallMemoryWithVector,
  recallRankingPolicyFromPlan,
  type AssociativeRecallResult,
  type RecallItem,
  type RecallScoreBreakdown,
} from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import type {
  RetrievalEvidenceRequirement,
  RetrievalStrategy,
} from "../../packages/butler-agent/src/agent/cognition/memory/retrieval-planning.ts";

type RecallMode = "lexical_only" | "vector_enabled" | "planned_vector_first";

interface QualityCase {
  id: string;
  category: "lexical-control" | "semantic-paraphrase" | "lexical-decoy" | "ambiguous-referent" | "negative";
  prompt: string;
  expected: string;
  targetGroups: string[][];
  decoyGroups?: string[][];
  vectorQueries?: string[];
}

interface ModeResult {
  mode: RecallMode;
  duration_ms: number;
  abstained: boolean;
  result_count: number;
  target_rank: number | null;
  decoy_rank: number | null;
  target_hit: boolean;
  top_target_hit: boolean;
  target_source: string | null;
  target_score_breakdown: Record<string, number> | null;
  target_vector_backed: boolean;
  decoy_hit: boolean;
  top_decoy_hit: boolean;
  vector_ok: boolean;
  vector_candidates: number;
  diagnostics: string[];
  sources: string[];
  top_source: string | null;
  top_score_breakdown: Record<string, number> | null;
  raw_memory_text_in_report: false;
}

interface CaseComparison {
  case_id: string;
  category: QualityCase["category"];
  prompt_id: string;
  prompt: string;
  expected: string;
  modes: ModeResult[];
  positive_target_missing: boolean;
  negative_false_positive: boolean;
  vector_lift: boolean;
  vector_regression: boolean;
  notes: string[];
}

const root = process.cwd();
const sourceButlerData = resolve(process.env.BUTLER_E2E_SOURCE_DATA || join(homedir(), ".butler"));
const runId = process.env.BUTLER_E2E_RUN_ID?.trim() ||
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runRoot = resolve(root, ".tmp", "memory-quality-ab", runId);
const snapshotButlerData = join(runRoot, "butler-data");
const evidenceDir = join(runRoot, "evidence");
const reportPath = join(evidenceDir, "report.json");
const summaryPath = join(evidenceDir, "summary.md");
const projectId = process.env.BUTLER_E2E_PROJECT_ID?.trim() || "butler";
const recallLimit = positiveInt(process.env.BUTLER_MEMORY_QUALITY_LIMIT, 5);
const vectorTimeoutMs = positiveInt(process.env.BUTLER_MEMORY_QUALITY_VECTOR_TIMEOUT_MS, 10_000);
const minScore = optionalFiniteNumber(process.env.BUTLER_MEMORY_QUALITY_MIN_SCORE);

const plannedStrategies: RetrievalStrategy[] = [
  "search_vector_episode",
  "search_lexical_memory",
  "read_graph_memory",
  "read_explicit_memory",
  "read_task_state",
];

const plannedVectorEvidence: RetrievalEvidenceRequirement[] = ["vector_episode_hit"];
const rawMemoryLeakScanMinChars = 120;
let hotCacheVectorBackfillBlocks = 0;

const cases: QualityCase[] = [
  {
    id: "MQ-LEX-1",
    category: "lexical-control",
    prompt: "웹 리더에서 Readability, fallback raw, 페이지 타입별 모드 얘기했던 결론을 다시 찾아줘.",
    expected: "Exact lexical anchors should retrieve the web-reader memory in both modes.",
    targetGroups: [
      ["readability", "fallback", "raw"],
      ["article", "product", "list"],
      ["본문", "유실"],
    ],
    decoyGroups: [["배포", "fallback"], ["model", "fallback"]],
    vectorQueries: ["Butler web reader Readability fallback raw article product list"],
  },
  {
    id: "MQ-SEM-1",
    category: "semantic-paraphrase",
    prompt: "웹페이지를 모델에 넣기 전에 군더더기는 줄이되 중요한 내용이 잘려나가지 않게 하자는 얘기 기억나?",
    expected: "Semantic/vector recall should recover the web-reader decision even with weak lexical overlap.",
    targetGroups: [
      ["readability"],
      ["fallback", "raw"],
      ["본문", "유실"],
      ["하이브리드", "추출"],
    ],
    decoyGroups: [["README"], ["게임", "대회"], ["Project", "Ledger"]],
    vectorQueries: ["Safari Reader Readability fallback raw article product list body loss hybrid extraction"],
  },
  {
    id: "MQ-DECOY-1",
    category: "lexical-decoy",
    prompt: "fallback이라는 단어가 들어간 것들 중에서 배포나 모델 fallback 말고, 웹 문서 읽기 품질 쪽 결론만 찾아줘.",
    expected: "Vector-enabled recall should avoid unrelated fallback memories and keep the web-reader target on top.",
    targetGroups: [
      ["readability"],
      ["fallback", "raw"],
      ["본문", "추출"],
    ],
    decoyGroups: [["배포", "fallback"], ["model", "fallback"], ["provider", "fallback"]],
    vectorQueries: ["web document reader fallback raw readability extraction quality"],
  },
  {
    id: "MQ-AMB-1",
    category: "ambiguous-referent",
    prompt: "그때 첫 공개 문서에서 처음 보는 사람한테 먼저 보여줘야 한다고 했던 방향이 뭐였지?",
    expected: "Ambiguous natural wording should find the public README planning memory.",
    targetGroups: [
      ["README", "첫", "공개"],
      ["랜딩", "Quick", "Start"],
      ["첫", "방문자"],
    ],
    decoyGroups: [["웹", "리더"], ["게임", "대회"]],
    vectorQueries: ["Butler first public README landing quick start first visitor"],
  },
  {
    id: "MQ-AMB-2",
    category: "ambiguous-referent",
    prompt: "그 작은 게임 관련해서 멀티플랫폼을 계속 고집하는 게 맞는지 이야기했던 결론이 뭐였어?",
    expected: "Ambiguous natural wording should retrieve the small-size game-stack decision.",
    targetGroups: [
      ["1.44MB", "게임"],
      ["C", "Win32"],
      ["Linux", "X11"],
      ["소프트웨어", "렌더러"],
    ],
    decoyGroups: [["README"], ["Project", "Ledger"], ["웹", "리더"]],
    vectorQueries: ["1.44MB game contest Win32 C Linux X11 software renderer multiplatform"],
  },
  {
    id: "MQ-NEG-1",
    category: "negative",
    prompt: "이미지 OCR 노이즈 제거에 대해 지난번에 확정한 Butler 메모리 결론을 찾아줘.",
    expected: "If the snapshot has no matching evidence, vector-enabled recall should not confidently surface a decoy.",
    targetGroups: [["이미지", "OCR", "노이즈"]],
    decoyGroups: [["readability"], ["README"], ["게임", "대회"], ["Project", "Ledger"]],
    vectorQueries: ["OCR text recognition noise cleanup scanned image preprocessing"],
  },
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function optionalFiniteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function copyButlerDataSnapshot(): void {
  assert(existsSync(sourceButlerData), `BUTLER_E2E_SOURCE_DATA does not exist: ${sourceButlerData}`);
  rmSync(snapshotButlerData, { recursive: true, force: true });
  mkdirSync(snapshotButlerData, { recursive: true });
  const result = spawnSync("rsync", [
    "-a",
    "--delete",
    "--exclude",
    "runtime/",
    "--exclude",
    "*.sock",
    `${sourceButlerData.replace(/\/$/, "")}/`,
    `${snapshotButlerData}/`,
  ], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`rsync snapshot failed: ${result.stderr || result.stdout}`);
  }
}

function indexHotCacheSnapshot(): number {
  const result = spawnSync("node", [
    "bin/butler.js",
    "cognition",
    "memory",
    "maintain",
    "--hot-cache-backfill-only",
    "--json",
    "--data",
    snapshotButlerData,
  ], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_HOME: root,
      BUTLER_DATA: snapshotButlerData,
    },
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error(`hot-cache vector backfill failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout) as {
    data?: {
      hotCacheVectorBackfill?: {
        indexed?: number;
        failed?: number;
      };
    };
  };
  const backfill = parsed.data?.hotCacheVectorBackfill;
  if (!backfill || (backfill.failed ?? 0) > 0) {
    throw new Error(`hot-cache vector backfill incomplete: ${result.stdout}`);
  }
  return backfill.indexed ?? 0;
}

function normalizedText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function textMatchesGroup(text: string, group: string[]): boolean {
  const haystack = normalizedText(text);
  return group.every((term) => haystack.includes(normalizedText(term)));
}

function itemInspectableText(item: RecallItem): string {
  return [
    item.summary,
    item.source,
    item.originalSource ?? "",
    ...item.provenance,
    ...item.related_nodes,
  ].join("\n");
}

function firstMatchingIndex(items: RecallItem[], groups: string[][]): number {
  return items.findIndex((item) =>
    groups.some((group) => textMatchesGroup(itemInspectableText(item), group)),
  );
}

function firstMatchingRank(items: RecallItem[], groups: string[][]): number | null {
  const index = firstMatchingIndex(items, groups);
  return index < 0 ? null : index + 1;
}

function diagnosticNumber(diagnostics: string[], key: string): number {
  const prefix = `${key}=`;
  const found = diagnostics.find((entry) => entry.startsWith(prefix));
  if (!found) return 0;
  const parsed = Number(found.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundedBreakdown(value: RecallScoreBreakdown | undefined): Record<string, number> | null {
  if (!value) return null;
  return {
    semantic_similarity: round(value.semantic_similarity),
    lexical_match: round(value.lexical_match),
    contextual_match: round(value.contextual_match),
    graph_activation: round(value.graph_activation),
    recency_score: round(value.recency_score),
    frequency_score: round(value.frequency_score),
    explicit_salience: round(value.explicit_salience),
    evidence_confidence: round(value.evidence_confidence),
    decision_preference_boost: round(value.decision_preference_boost),
    hub_penalty: round(value.hub_penalty),
    conflict_penalty: round(value.conflict_penalty),
    stale_superseded_penalty: round(value.stale_superseded_penalty),
    total: round(value.total),
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function runMode(qualityCase: QualityCase, mode: RecallMode): Promise<ModeResult> {
  const startedAt = Date.now();
  const result = await runRecall(qualityCase, mode);
  const durationMs = Date.now() - startedAt;
  const targetIndex = firstMatchingIndex(result.items, qualityCase.targetGroups);
  const targetRank = targetIndex < 0 ? null : targetIndex + 1;
  const targetItem = targetIndex < 0 ? undefined : result.items[targetIndex];
  const decoyRank = qualityCase.decoyGroups ? firstMatchingRank(result.items, qualityCase.decoyGroups) : null;
  const sources = result.items.map((item) => item.source);
  return {
    mode,
    duration_ms: durationMs,
    abstained: result.abstained,
    result_count: result.items.length,
    target_rank: targetRank,
    decoy_rank: decoyRank,
    target_hit: targetRank !== null,
    top_target_hit: targetRank === 1,
    target_source: targetItem?.source ?? null,
    target_score_breakdown: roundedBreakdown(targetItem?.score_breakdown),
    target_vector_backed: Boolean(
      targetItem &&
        targetItem.score_breakdown.semantic_similarity > 0 &&
        (targetItem.source === "vector" || targetItem.source === "hybrid"),
    ),
    decoy_hit: decoyRank !== null,
    top_decoy_hit: decoyRank === 1,
    vector_ok: result.diagnostics.includes("vector=ok"),
    vector_candidates: diagnosticNumber(result.diagnostics, "vector_candidates"),
    diagnostics: result.diagnostics,
    sources,
    top_source: sources[0] ?? null,
    top_score_breakdown: roundedBreakdown(result.items[0]?.score_breakdown),
    raw_memory_text_in_report: false,
  };
}

async function runRecall(qualityCase: QualityCase, mode: RecallMode): Promise<AssociativeRecallResult> {
  if (mode === "lexical_only") {
    return recallMemory({
      butlerData: snapshotButlerData,
      cue: qualityCase.prompt,
      projectId,
      limit: recallLimit,
      ...(minScore === undefined ? {} : { minScore }),
    });
  }
  const rankingPolicy = mode === "planned_vector_first"
    ? {
      ...recallRankingPolicyFromPlan({
        strategies: plannedStrategies,
        evidence_required: plannedVectorEvidence,
      }),
    }
    : undefined;
  return await recallMemoryWithVector({
    butlerData: snapshotButlerData,
    cue: qualityCase.prompt,
    projectId,
    limit: recallLimit,
    ...(minScore === undefined ? {} : { minScore }),
    vectorQueries: qualityCase.vectorQueries,
    vectorTimeoutMs,
    rankingPolicy,
  });
}

async function runCase(qualityCase: QualityCase): Promise<CaseComparison> {
  const modes: ModeResult[] = [];
  for (const mode of ["lexical_only", "vector_enabled", "planned_vector_first"] as RecallMode[]) {
    modes.push(await runMode(qualityCase, mode));
  }
  const lexical = requiredMode(modes, "lexical_only");
  const vector = requiredMode(modes, "vector_enabled");
  const planned = requiredMode(modes, "planned_vector_first");
  const positiveTargetMissing = qualityCase.category !== "negative" &&
    !vector.target_hit;
  const negativeFalsePositive = qualityCase.category === "negative" &&
    modes.some((mode) => !mode.abstained || mode.target_hit || mode.top_decoy_hit);
  const vectorLift = rankImproved(lexical.target_rank, vector.target_rank) ||
    (!lexical.top_target_hit && vector.top_target_hit);
  const vectorRegression = Boolean(
    lexical.target_hit &&
      (!vector.target_hit || vector.top_decoy_hit || rankWorse(lexical.target_rank, vector.target_rank)),
  );
  return {
    case_id: qualityCase.id,
    category: qualityCase.category,
    prompt_id: hashText(qualityCase.prompt),
    prompt: qualityCase.prompt,
    expected: qualityCase.expected,
    modes,
    positive_target_missing: positiveTargetMissing,
    negative_false_positive: negativeFalsePositive,
    vector_lift: vectorLift,
    vector_regression: vectorRegression,
    notes: comparisonNotes(qualityCase, lexical, vector, planned),
  };
}

function requiredMode(modes: ModeResult[], mode: RecallMode): ModeResult {
  const found = modes.find((item) => item.mode === mode);
  assert(found, `missing mode result: ${mode}`);
  return found;
}

function rankImproved(before: number | null, after: number | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  return after < before;
}

function rankWorse(before: number | null, after: number | null): boolean {
  if (before === null) return false;
  if (after === null) return true;
  return after > before;
}

function comparisonNotes(
  qualityCase: QualityCase,
  lexical: ModeResult,
  vector: ModeResult,
  planned: ModeResult,
): string[] {
  const notes: string[] = [];
  const modes = [lexical, vector, planned];
  if (qualityCase.category !== "negative" && !modes.some((mode) => mode.target_hit)) {
    notes.push("positive_target_missing");
  }
  if (qualityCase.category === "negative" && modes.some((mode) => !mode.abstained)) {
    notes.push("negative_non_abstained");
  }
  if (!vector.vector_ok && !planned.vector_ok) notes.push("vector_backend_not_observed");
  if (vector.top_target_hit && !lexical.top_target_hit) notes.push("vector_enabled_promoted_target_to_top");
  if (planned.top_target_hit && !lexical.top_target_hit) notes.push("planned_vector_promoted_target_to_top");
  if (lexical.target_hit && !vector.target_hit) notes.push("vector_enabled_lost_lexical_target");
  if (vector.top_decoy_hit) notes.push("vector_enabled_top_decoy");
  if (planned.target_vector_backed && !vector.target_vector_backed) notes.push("planned_vector_evidence_observed");
  if (planned.abstained && vector.target_hit) notes.push("planned_vector_first_abstained");
  if (!lexical.target_hit && !vector.target_hit && !planned.target_hit) notes.push("no_mode_found_target");
  return notes;
}

function writeReport(comparisons: CaseComparison[]): void {
  mkdirSync(evidenceDir, { recursive: true });
  const vectorOkCases = comparisons.filter((comparison) =>
    comparison.modes.some((mode) => mode.mode !== "lexical_only" && mode.vector_ok),
  ).length;
  const vectorLiftCases = comparisons.filter((comparison) => comparison.vector_lift).length;
  const regressionCases = comparisons.filter((comparison) => comparison.vector_regression);
  const decoyTopCases = comparisons.filter((comparison) =>
    comparison.modes.some((mode) => mode.mode === "vector_enabled" && mode.top_decoy_hit),
  );
  const positiveTargetMissCases = comparisons.filter((comparison) => comparison.positive_target_missing);
  const negativeFalsePositiveCases = comparisons.filter((comparison) => comparison.negative_false_positive);
  const vectorBackedTargetCases = comparisons.filter((comparison) =>
    comparison.category !== "negative" &&
    requiredMode(comparison.modes, "vector_enabled").target_vector_backed,
  );
  const positiveVectorBackedMissCases = comparisons.filter((comparison) =>
    comparison.category !== "negative" &&
    !requiredMode(comparison.modes, "vector_enabled").target_vector_backed,
  );
  const report = {
    run_id: runId,
    source_data_label: sourceButlerData.replace(homedir(), "~"),
    snapshot_data_label: snapshotButlerData.replace(root, "."),
    project_id: projectId,
    recall_limit: recallLimit,
    min_score: minScore ?? "engine-default",
    vector_timeout_ms: vectorTimeoutMs,
    raw_memory_leak_scan_min_chars: rawMemoryLeakScanMinChars,
    hot_cache_vector_backfill_blocks: hotCacheVectorBackfillBlocks,
    generated_at: new Date().toISOString(),
    privacy: {
      raw_memory_text_in_report: false,
      prompt_text_is_synthetic_and_non_private: true,
      scoring_used_memory_text_in_process_only: true,
      raw_memory_text_scan_min_chars: rawMemoryLeakScanMinChars,
    },
    aggregate: {
      case_count: comparisons.length,
      vector_ok_cases: vectorOkCases,
      vector_lift_cases: vectorLiftCases,
      vector_regression_cases: regressionCases.length,
      vector_top_decoy_cases: decoyTopCases.length,
      positive_target_miss_cases: positiveTargetMissCases.length,
      negative_false_positive_cases: negativeFalsePositiveCases.length,
      vector_backed_target_cases: vectorBackedTargetCases.length,
      positive_vector_backed_miss_cases: positiveVectorBackedMissCases.length,
    },
    comparisons,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(summaryPath, renderSummary(report.aggregate, comparisons), "utf8");
  assertReportDoesNotContainRawMemoryText(reportPath);
  assertReportDoesNotContainRawMemoryText(summaryPath);
}

function renderSummary(
  aggregate: {
    case_count: number;
    vector_ok_cases: number;
    vector_lift_cases: number;
    vector_regression_cases: number;
    vector_top_decoy_cases: number;
    positive_target_miss_cases: number;
    negative_false_positive_cases: number;
    vector_backed_target_cases: number;
    positive_vector_backed_miss_cases: number;
  },
  comparisons: CaseComparison[],
): string {
  const lines = [
    "# Butler Memory Quality A/B",
    "",
    `- run_id: ${runId}`,
    `- source_data_label: ${sourceButlerData.replace(homedir(), "~")}`,
    `- project_id: ${projectId}`,
    `- cases: ${aggregate.case_count}`,
    `- vector_ok_cases: ${aggregate.vector_ok_cases}`,
    `- vector_lift_cases: ${aggregate.vector_lift_cases}`,
    `- vector_regression_cases: ${aggregate.vector_regression_cases}`,
    `- vector_top_decoy_cases: ${aggregate.vector_top_decoy_cases}`,
    `- positive_target_miss_cases: ${aggregate.positive_target_miss_cases}`,
    `- negative_false_positive_cases: ${aggregate.negative_false_positive_cases}`,
    `- vector_backed_target_cases: ${aggregate.vector_backed_target_cases}`,
    `- positive_vector_backed_miss_cases: ${aggregate.positive_vector_backed_miss_cases}`,
    `- hot_cache_vector_backfill_blocks: ${hotCacheVectorBackfillBlocks}`,
    "- raw_memory_text_in_report: false",
    "",
    "| case | category | lexical target | vector target | planned target | vector-backed target | vector ok | lift | regression | notes |",
    "| --- | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |",
  ];
  for (const comparison of comparisons) {
    const lexical = requiredMode(comparison.modes, "lexical_only");
    const vector = requiredMode(comparison.modes, "vector_enabled");
    const planned = requiredMode(comparison.modes, "planned_vector_first");
    lines.push([
      comparison.case_id,
      comparison.category,
      rankLabel(lexical.target_rank),
      rankLabel(vector.target_rank),
      rankLabel(planned.target_rank),
      vector.target_vector_backed || planned.target_vector_backed ? "yes" : "no",
      vector.vector_ok || planned.vector_ok ? "yes" : "no",
      comparison.vector_lift ? "yes" : "no",
      comparison.vector_regression ? "yes" : "no",
      comparison.notes.join(", ") || "-",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push("Detailed numeric evidence is in `report.json`; memory summaries are intentionally omitted.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function rankLabel(value: number | null): string {
  return value === null ? "-" : String(value);
}

function listTextFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      output.push(...listTextFiles(path));
      continue;
    }
    if (entry.endsWith(".md") || entry.endsWith(".txt")) output.push(path);
  }
  return output;
}

function rawMemoryLeakNeedles(): string[] {
  const memoryDir = join(snapshotButlerData, "cognition", "memory");
  const needles: string[] = [];
  for (const path of listTextFiles(memoryDir)) {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const normalized = line.replace(/\s+/g, " ").trim();
      if (normalized.length >= rawMemoryLeakScanMinChars) needles.push(normalized);
    }
  }
  return [...new Set(needles)].slice(0, 1_000);
}

function assertReportDoesNotContainRawMemoryText(path: string): void {
  const reportText = readFileSync(path, "utf8");
  const leaked = rawMemoryLeakNeedles().find((needle) => reportText.includes(needle));
  assert(!leaked, `memory quality report leaked raw memory text into ${path}`);
}

async function main(): Promise<void> {
  copyButlerDataSnapshot();
  hotCacheVectorBackfillBlocks = indexHotCacheSnapshot();
  const comparisons: CaseComparison[] = [];
  for (const qualityCase of cases) {
    comparisons.push(await runCase(qualityCase));
  }
  writeReport(comparisons);

  const vectorObserved = comparisons.some((comparison) =>
    comparison.modes.some((mode) => mode.mode !== "lexical_only" && mode.vector_ok),
  );
  const vectorRegressions = comparisons.filter((comparison) => comparison.vector_regression);
  const vectorTopDecoys = comparisons.filter((comparison) =>
    comparison.modes.some((mode) => mode.mode === "vector_enabled" && mode.top_decoy_hit),
  );
  const positiveTargetMisses = comparisons.filter((comparison) => comparison.positive_target_missing);
  const negativeFalsePositives = comparisons.filter((comparison) => comparison.negative_false_positive);
  const vectorBackedTargetCases = comparisons.filter((comparison) =>
    comparison.category !== "negative" &&
    requiredMode(comparison.modes, "vector_enabled").target_vector_backed,
  );
  const positiveVectorBackedMisses = comparisons.filter((comparison) =>
    comparison.category !== "negative" &&
    !requiredMode(comparison.modes, "vector_enabled").target_vector_backed,
  );

  console.log(`memory quality report: ${summaryPath}`);
  console.log(`memory quality json: ${reportPath}`);
  console.log(
    `aggregate: cases=${comparisons.length}, vectorObserved=${vectorObserved}, ` +
      `lifts=${comparisons.filter((comparison) => comparison.vector_lift).length}, ` +
      `regressions=${vectorRegressions.length}, topDecoys=${vectorTopDecoys.length}, ` +
      `positiveMisses=${positiveTargetMisses.length}, negativeFalsePositives=${negativeFalsePositives.length}, ` +
      `vectorBackedTargets=${vectorBackedTargetCases.length}`,
  );

  assert(vectorObserved, "vector-enabled recall did not produce vector=ok in any quality case");
  assert(hotCacheVectorBackfillBlocks > 0, "memory quality did not backfill any hot-cache blocks into vector index");
  assert(
    positiveTargetMisses.length === 0,
    `memory quality positive cases missed target evidence: ${positiveTargetMisses.map((item) => item.case_id).join(", ")}`,
  );
  assert(
    negativeFalsePositives.length === 0,
    `memory quality negative cases returned confident evidence: ${negativeFalsePositives.map((item) => item.case_id).join(", ")}`,
  );
  assert(vectorRegressions.length === 0, `vector-enabled recall regressed target ranking: ${vectorRegressions.map((item) => item.case_id).join(", ")}`);
  assert(
    positiveVectorBackedMisses.length === 0,
    `memory quality positive cases lacked vector-backed target evidence: ${positiveVectorBackedMisses.map((item) => item.case_id).join(", ")}`,
  );
  assert(vectorTopDecoys.length === 0, `vector-enabled recall promoted decoy evidence: ${vectorTopDecoys.map((item) => item.case_id).join(", ")}`);
}

await main();
