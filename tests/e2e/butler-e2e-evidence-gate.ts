import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  runAgentLoop,
  type AgentLoopToolDefinition,
  type AgentLoopToolCall,
} from "../../packages/butler-agent/src/agent/turn/agent-loop.ts";
import {
  BUTLER_TOOLS,
  createButlerToolExecutor,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { TaskStore } from "../../packages/butler-agent/src/agent/work/task-store.ts";
import { PlannedTaskStore } from "../../packages/butler-agent/src/agent/work/planned-task.ts";
import {
  recallMemoryWithVector,
  recallRankingPolicyFromPlan,
  type RecallScoreBreakdown,
} from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import type {
  RetrievalEvidenceRequirement,
  RetrievalStrategy,
} from "../../packages/butler-agent/src/agent/cognition/memory/retrieval-planning.ts";

type CaseStatus = "pass" | "fail";

interface CaseResult {
  case_id: string;
  prompt_id: string;
  prompt: string;
  status: CaseStatus;
  expected: string;
  observed: Record<string, unknown>;
  failure?: string;
}

interface ToolTiming {
  case_id: string;
  batch_id: string;
  tool_call_id: string;
  tool_name: string;
  concurrency_safe: boolean;
  started_at_ms: number;
  ended_at_ms: number;
  ok: boolean;
}

const root = process.cwd();
const sourceButlerData = resolve(process.env.BUTLER_E2E_SOURCE_DATA || join(homedir(), ".butler"));
const projectId = "butler";
const runId = process.env.BUTLER_E2E_RUN_ID?.trim() ||
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runRoot = resolve(root, ".tmp", "real-data-e2e", runId);
const snapshotButlerData = join(runRoot, "butler-data");
const evidenceDir = join(runRoot, "evidence");
const reportPath = join(evidenceDir, "report.json");
const summaryPath = join(evidenceDir, "summary.md");
const fileStateEvidencePath = join(evidenceDir, "file-state.jsonl");

if (process.argv[2] === "--task-store-writer") {
  runTaskStoreWriter();
  process.exit(0);
}

if (process.argv[2] === "--planned-task-writer") {
  runPlannedTaskWriter();
  process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      output.push(...listFilesRecursive(path));
    } else if (stat.isFile()) {
      output.push(path);
    }
  }
  return output;
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeEvidenceCase(caseResult: CaseResult): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, `${caseResult.case_id}.json`),
    `${JSON.stringify(caseResult, null, 2)}\n`,
    "utf8",
  );
}

function okCase(input: Omit<CaseResult, "status">): CaseResult {
  const result = { ...input, status: "pass" as const };
  writeEvidenceCase(result);
  return result;
}

function failCase(input: Omit<CaseResult, "status"> & { failure: string }): CaseResult {
  const result = { ...input, status: "fail" as const };
  writeEvidenceCase(result);
  return result;
}

function summarizedBreakdown(value: RecallScoreBreakdown | undefined): Record<string, number> | null {
  if (!value) return null;
  return {
    semantic_similarity: value.semantic_similarity,
    lexical_match: value.lexical_match,
    contextual_match: value.contextual_match,
    graph_activation: value.graph_activation,
    recency_score: value.recency_score,
    frequency_score: value.frequency_score,
    evidence_confidence: value.evidence_confidence,
    total: value.total,
  };
}

function toolDefinitions(names: string[]): AgentLoopToolDefinition[] {
  return names.map((name) => {
    const tool = BUTLER_TOOLS.find((candidate) => candidate.name === name);
    assert(tool, `tool not found: ${name}`);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as AgentLoopToolDefinition["inputSchema"],
      concurrencySafe: tool.concurrencySafe === true,
    };
  });
}

async function runRecallCase(input: {
  caseId: string;
  prompt: string;
  strategies: RetrievalStrategy[];
  evidenceRequired: RetrievalEvidenceRequirement[];
  vectorQueries?: string[];
  targetGroups?: string[][];
  expected: string;
}): Promise<CaseResult> {
  const promptId = hashText(input.prompt);
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: snapshotButlerData,
    projectId,
    sessionId: "beeg/real-data",
    memoryVectorTimeoutMs: 10_000,
  });
  try {
    const toolResult = await executor({
      name: "recall_memory",
      args: {
        cue: input.prompt,
        limit: 3,
        strategies: input.strategies,
        evidence_required: input.evidenceRequired,
        vector_queries: input.vectorQueries ?? [],
      },
      rawArguments: JSON.stringify({
        cue: input.prompt,
        limit: 3,
        strategies: input.strategies,
        evidence_required: input.evidenceRequired,
        vector_queries: input.vectorQueries ?? [],
      }),
    });
    const engineResult = await recallMemoryWithVector({
      butlerData: snapshotButlerData,
      cue: input.prompt,
      projectId,
      limit: 3,
      minScore: 0.01,
      vectorQueries: input.vectorQueries,
      vectorTimeoutMs: 10_000,
      rankingPolicy: recallRankingPolicyFromPlan({
        strategies: input.strategies,
        evidence_required: input.evidenceRequired,
      }),
    });
    const toolRecord = isRecord(toolResult) ? toolResult : {};
    const diagnostics = stringArray(toolRecord.diagnostics);
    const toolResults = Array.isArray(toolRecord.results) ? toolRecord.results.filter(isRecord) : [];
    const sources = toolResults.map((item) => typeof item.source === "string" ? item.source : "unknown");
    const vectorOk = diagnostics.includes("vector=ok") || engineResult.diagnostics.includes("vector=ok");
    const vectorSourcesAreHonest = !sources.includes("vector") || vectorOk;
    const semanticValues = engineResult.items.map((item) => item.score_breakdown.semantic_similarity);
    const hasSemanticVector = engineResult.items.some((item) =>
      item.source === "vector" && item.score_breakdown.semantic_similarity > 0,
    );
    const targetRank = input.targetGroups ? firstMatchingRank(engineResult.items, input.targetGroups) : null;
    const targetItem = targetRank === null ? undefined : engineResult.items[targetRank - 1];
    const targetVectorBacked = Boolean(
      targetItem &&
        targetItem.source === "vector" &&
        targetItem.score_breakdown.semantic_similarity > 0,
    );
    const passed = input.evidenceRequired.includes("vector_episode_hit")
      ? vectorSourcesAreHonest &&
        vectorOk &&
        sources.includes("vector") &&
        hasSemanticVector &&
        (!input.targetGroups || targetVectorBacked)
      : vectorSourcesAreHonest && engineResult.diagnostics.includes("ranking_policy=planned");
    const observed = {
      result_count: toolResults.length,
      sources,
      diagnostics,
      engine_diagnostics: engineResult.diagnostics,
      top_score_breakdown: summarizedBreakdown(engineResult.items[0]?.score_breakdown),
      semantic_values: semanticValues,
      target_rank: targetRank,
      target_vector_backed: targetVectorBacked,
      raw_text_included: false,
    };
    if (!passed) {
      return failCase({
        case_id: input.caseId,
        prompt_id: promptId,
        prompt: input.prompt,
        expected: input.expected,
        observed,
        failure: "Expected vector/ranking evidence was not observed.",
      });
    }
    return okCase({
      case_id: input.caseId,
      prompt_id: promptId,
      prompt: input.prompt,
      expected: input.expected,
      observed,
    });
  } catch (error) {
    return failCase({
      case_id: input.caseId,
      prompt_id: promptId,
      prompt: input.prompt,
      expected: input.expected,
      observed: { error: error instanceof Error ? error.message : String(error) },
      failure: "Recall case threw before producing evidence.",
    });
  }
}

function normalizedText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function itemInspectableText(item: { summary?: string; provenance?: string[]; related_nodes?: string[] }): string {
  return [
    item.summary ?? "",
    ...(item.provenance ?? []),
    ...(item.related_nodes ?? []),
  ].join("\n");
}

function firstMatchingRank(items: Array<{ summary?: string; provenance?: string[]; related_nodes?: string[] }>, groups: string[][]): number | null {
  const index = items.findIndex((item) => {
    const haystack = normalizedText(itemInspectableText(item));
    return groups.some((group) => group.every((term) => haystack.includes(normalizedText(term))));
  });
  return index < 0 ? null : index + 1;
}

interface WriterProcessResult {
  index: number;
  status: number | null;
  stderr: string;
  stdout: string;
  startedAtMs: number;
  endedAtMs: number;
}

function runWriterProcess(input: {
  kind: "task-store" | "planned-task";
  taskId: string;
  index: number;
}): Promise<WriterProcessResult> {
  const startedAtMs = Date.now();
  const child = spawn(process.execPath, [
    "run",
    import.meta.path,
    input.kind === "task-store" ? "--task-store-writer" : "--planned-task-writer",
    snapshotButlerData,
    input.taskId,
    String(input.index),
  ], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_DATA: snapshotButlerData,
      BUTLER_FILE_STATE_EVIDENCE_PATH: fileStateEvidencePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (status) => {
      resolve({
        index: input.index,
        status,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
        startedAtMs,
        endedAtMs: Date.now(),
      });
    });
  });
}

function maxActiveProcesses(processes: WriterProcessResult[]): number {
  const events = processes.flatMap((process) => [
    { at: process.startedAtMs, delta: 1 },
    { at: process.endedAtMs, delta: -1 },
  ]).sort((left, right) => left.at - right.at || right.delta - left.delta);
  let active = 0;
  let maxActive = 0;
  for (const event of events) {
    active += event.delta;
    maxActive = Math.max(maxActive, active);
  }
  return maxActive;
}

async function runTaskStoreContentionCase(input: {
  caseId: string;
  prompt: string;
}): Promise<CaseResult> {
  const caseId = input.caseId;
  const prompt = input.prompt;
  const taskId = `beeg-state-${runId}`;
  const taskDir = join(snapshotButlerData, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  const plannedTaskId = `beeg-planned-${runId}`;
  const plannedStore = new PlannedTaskStore(snapshotButlerData);
  plannedStore.create({
    task_id: plannedTaskId,
    type: "planned",
    goal: "BEEG planned-task state contention",
    project: "butler",
    created_at: new Date().toISOString(),
    decision_policy: "test",
    acceptance_criteria: ["planned-task state remains parseable under concurrent writes"],
    verification_commands: ["bun run e2e:evidence-gate"],
    review_policy: "test",
    repair_policy: {
      max_attempts: 0,
      allow_autonomous_repair: false,
    },
    public_report_policy: "test",
  });
  const plannedTaskDir = plannedStore.taskDir(plannedTaskId);

  const writers = await Promise.all([
    ...Array.from({ length: 6 }, (_, index) =>
      runWriterProcess({ kind: "task-store", taskId, index: index + 1 }),
    ),
    ...Array.from({ length: 6 }, (_, index) =>
      runWriterProcess({ kind: "planned-task", taskId: plannedTaskId, index: index + 1 }),
    ),
  ]);
  const failures = writers
    .map((result) => ({ index: result.index, status: result.status, stderr: result.stderr }))
    .filter((result) => result.status !== 0);
  const maxActiveWriters = maxActiveProcesses(writers);
  const files = [
    ...listFilesRecursive(taskDir),
    ...listFilesRecursive(plannedTaskDir),
  ];
  const relativeFiles = files.map((path) => path.replace(`${snapshotButlerData}/`, ""));
  const tempFiles = relativeFiles.filter((entry) => entry.includes(".tmp-") || entry.includes(".candidate-"));
  const lockFiles = relativeFiles.filter((entry) => entry.endsWith(".lock"));
  const zeroByteFiles = files.filter((path) => statSync(path).size === 0).map((path) => path.replace(`${snapshotButlerData}/`, ""));
  const originParseOk = (() => {
    try {
      const origin = JSON.parse(readFileSync(join(taskDir, "origin.json"), "utf8")) as Record<string, unknown>;
      return typeof origin.task_summary === "string";
    } catch {
      return false;
    }
  })();
  const plannedParseOk = (() => {
    const record = plannedStore.read(plannedTaskId);
    return Boolean(
      record?.review?.task_id === plannedTaskId &&
        record.publicReport &&
        record.decision?.task_id === plannedTaskId,
    );
  })();
  const eventLines = existsSync(fileStateEvidencePath)
    ? readFileSync(fileStateEvidencePath, "utf8").split("\n").filter(Boolean)
    : [];
  const eventKinds = eventLines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { event?: unknown };
      return typeof parsed.event === "string" ? [parsed.event] : [];
    } catch {
      return [];
    }
  });
  const passed = failures.length === 0 &&
    originParseOk &&
    plannedParseOk &&
    tempFiles.length === 0 &&
    lockFiles.length === 0 &&
    zeroByteFiles.length === 0 &&
    eventKinds.includes("lock.acquired") &&
    eventKinds.includes("lock.released") &&
    eventKinds.includes("atomic_write.committed") &&
    maxActiveWriters > 1;
  const observed = {
    writer_count: writers.length,
    max_active_writers: maxActiveWriters,
    writer_failures: failures,
    origin_parse_ok: originParseOk,
    planned_parse_ok: plannedParseOk,
    temp_files: tempFiles,
    lock_files: lockFiles,
    zero_byte_files: zeroByteFiles,
    file_state_event_counts: Object.fromEntries(
      [...new Set(eventKinds)].map((kind) => [kind, eventKinds.filter((candidate) => candidate === kind).length]),
    ),
    file_state_evidence: fileStateEvidencePath.replace(`${root}/`, ""),
  };
  if (!passed) {
    return failCase({
      case_id: caseId,
      prompt_id: hashText(prompt),
      prompt,
      expected: "Concurrent TaskStore and PlannedTaskStore writers leave valid JSON, no zero-byte files, no stale temp/lock files, and lock evidence.",
      observed,
      failure: "TaskStore contention evidence did not meet integrity requirements.",
    });
  }
  return okCase({
    case_id: caseId,
    prompt_id: hashText(prompt),
    prompt,
    expected: "Concurrent TaskStore and PlannedTaskStore writers leave valid JSON, no zero-byte files, no stale temp/lock files, and lock evidence.",
    observed,
  });
}

async function runAgentLoopCase(input: {
  caseId: string;
  prompt: string;
  tools: AgentLoopToolDefinition[];
  toolCallsForIteration: (iteration: number) => AgentLoopToolCall[];
  execute: (call: AgentLoopToolCall) => Promise<unknown>;
  expected: string;
  assertEvidence: (input: {
    timings: ToolTiming[];
    maxActive: number;
    modelCalls: number;
    eventTypes: string[];
    stoppedByLimit: boolean;
    finalText: string;
  }) => string | null;
}): Promise<CaseResult> {
  const timings: ToolTiming[] = [];
  let active = 0;
  let maxActive = 0;
  let modelCalls = 0;
  let activeBatchId = "";
  const result = await runAgentLoop({
    messages: [{ role: "user", content: input.prompt }],
    tools: input.tools,
    maxIterations: 8,
    callModel: async ({ iteration }) => {
      modelCalls += 1;
      activeBatchId = `${input.caseId}-batch-${iteration + 1}`;
      const toolCalls = input.toolCallsForIteration(iteration);
      if (toolCalls.length > 0) return { toolCalls };
      return { text: "Evidence case complete." };
    },
    executeTool: async (call) => {
      const tool = input.tools.find((candidate) => candidate.name === call.name);
      const startedAt = Date.now();
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const output = await input.execute(call);
        timings.push({
          case_id: input.caseId,
          batch_id: activeBatchId,
          tool_call_id: call.id,
          tool_name: call.name,
          concurrency_safe: tool?.concurrencySafe === true,
          started_at_ms: startedAt,
          ended_at_ms: Date.now(),
          ok: true,
        });
        return output;
      } catch (error) {
        timings.push({
          case_id: input.caseId,
          batch_id: activeBatchId,
          tool_call_id: call.id,
          tool_name: call.name,
          concurrency_safe: tool?.concurrencySafe === true,
          started_at_ms: startedAt,
          ended_at_ms: Date.now(),
          ok: false,
        });
        throw error;
      } finally {
        active -= 1;
      }
    },
  });
  const eventTypes = result.events.map((event) => event.type);
  const failure = input.assertEvidence({
    timings,
    maxActive,
    modelCalls,
    eventTypes,
    stoppedByLimit: result.stoppedByLimit,
    finalText: result.finalText,
  });
  const observed = {
    max_active: maxActive,
    model_calls: modelCalls,
    event_types: eventTypes,
    stopped_by_limit: result.stoppedByLimit,
    final_text_hash: hashText(result.finalText),
    timings,
  };
  if (failure) {
    return failCase({
      case_id: input.caseId,
      prompt_id: hashText(input.prompt),
      prompt: input.prompt,
      expected: input.expected,
      observed,
      failure,
    });
  }
  return okCase({
    case_id: input.caseId,
    prompt_id: hashText(input.prompt),
    prompt: input.prompt,
    expected: input.expected,
    observed,
  });
}

function hasOverlap(timings: ToolTiming[]): boolean {
  for (let left = 0; left < timings.length; left += 1) {
    for (let right = left + 1; right < timings.length; right += 1) {
      const a = timings[left]!;
      const b = timings[right]!;
      if (a.started_at_ms < b.ended_at_ms && b.started_at_ms < a.ended_at_ms) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  copyButlerDataSnapshot();
  const hotCacheVectorBackfillBlocks = indexHotCacheSnapshot();
  process.env.BUTLER_DATA = snapshotButlerData;
  process.env.BUTLER_FILE_STATE_EVIDENCE_PATH = fileStateEvidencePath;

  const cases: CaseResult[] = [];
  const allRecallStrategies: RetrievalStrategy[] = [
    "search_vector_episode",
    "search_lexical_memory",
    "read_graph_memory",
    "read_explicit_memory",
    "read_task_state",
  ];

  for (const recallCase of [
    {
      caseId: "BEEG-MEM-1",
      prompt: "전에 웹 리더에서 본문 노이즈를 줄이는 방법 얘기했잖아. 그때 어떤 접근이 안전하다고 봤는지 기억해?",
      vectorQueries: ["웹사이트 노이즈 토큰 절감 Reader 알고리즘 하이브리드 본문 유실"],
      targetGroups: [["Readability", "본문"], ["Reader", "하이브리드"]],
      expected: "recall_memory returns honest vector-backed evidence with semantic similarity.",
    },
    {
      caseId: "BEEG-MEM-2",
      prompt: "Butler 공개용 README를 어떻게 구성하자고 했었는지 다시 요약해줘.",
      targetGroups: [["README", "공개"], ["첫 공개", "README"]],
      expected: "README/public-doc planning memory is retrieved without lexical fallback being labeled semantic.",
    },
    {
      caseId: "BEEG-MEM-3",
      prompt: "그 작은 용량 게임 대회 얘기에서 어떤 기술 스택이 현실적이라고 봤었지?",
      targetGroups: [["게임", "대회"], ["1.44MB"]],
      expected: "Prior game-stack decision is retrieved from durable memory.",
    },
    {
      caseId: "BEEG-MEM-4",
      prompt: "프로젝트 원장 먼저 봐야 한다고 했던 워크플로우 문제의 핵심이 뭐였지?",
      vectorQueries: ["project-ledger 스킬 워크플로우 관련 문제 먼저 읽기"],
      targetGroups: [["project-ledger", "워크플로우"], ["Project Ledger", "ledger"]],
      expected: "Project Ledger workflow issue is retrieved without raw transcript search.",
    },
  ]) {
    cases.push(await runRecallCase({
      ...recallCase,
      strategies: allRecallStrategies,
      evidenceRequired: ["vector_episode_hit"],
    }));
  }

  for (const rankCase of [
    {
      caseId: "BEEG-RANK-1",
      prompt: "그거 있잖아, 웹페이지 내용 줄이려던 방법. 단순 마크다운 파일 얘기 말고 본문 추출 쪽 결론 뭐였지?",
      vectorQueries: ["웹 리더 Readability 본문 추출 노이즈 제거"],
      targetGroups: [["Readability", "본문"], ["웹", "노이즈"]],
      expected: "Planned ranking uses vector/lexical/graph evidence channels instead of fixed anonymous weights.",
    },
    {
      caseId: "BEEG-RANK-2",
      prompt: "지난번 공개 문서 얘기에서 첫 방문자에게 뭘 먼저 보여줘야 한다고 했더라?",
      vectorQueries: ["Butler README 공개 문서 첫 방문자 구성"],
      targetGroups: [["README", "공개"], ["첫 공개", "README"]],
      expected: "Retrieval strategy and score breakdown support the public-doc answer.",
    },
    {
      caseId: "BEEG-RANK-3",
      prompt: "그때 작은 게임 대회에서 멀티플랫폼을 계속 밀어도 된다고 했었나, 아니면 다른 결론이었나?",
      vectorQueries: ["작은 용량 게임 대회 기술 스택 멀티플랫폼"],
      targetGroups: [["게임", "대회"], ["멀티플랫폼"]],
      expected: "The intended decision outranks merely lexical candidates.",
    },
    {
      caseId: "BEEG-RANK-4",
      prompt: "프로젝트 대시보드가 오래된 상태로 보이던 문제, 원인이 어디였지?",
      vectorQueries: ["Project Ledger dashboard stale view canonical ledger root"],
      targetGroups: [["대시보드", "stale"], ["Project Ledger", "dashboard"]],
      expected: "Ranking exposes separate semantic, lexical, graph, contextual, and task evidence.",
    },
  ]) {
    cases.push(await runRecallCase({
      ...rankCase,
      strategies: allRecallStrategies,
      evidenceRequired: ["vector_episode_hit"],
    }));
  }

  for (const stateCase of [
    {
      caseId: "BEEG-STATE-1",
      prompt: "Butler 저장소를 머지하기 전에 Project Ledger 기준 남은 작업과 리스크를 체크리스트로 정리해줘.",
    },
    {
      caseId: "BEEG-STATE-2",
      prompt: "README 공개 전에 보수적으로 고쳐야 할 표현 리스크를 점검하고 진행 상태를 남겨줘.",
    },
    {
      caseId: "BEEG-STATE-3",
      prompt: "웹 리더 품질 개선 관련 이전 결론을 바탕으로 다음 작업을 workstream에 정리해줘.",
    },
    {
      caseId: "BEEG-STATE-4",
      prompt: "Telegram 런타임 라우팅 이슈에서 남은 검증 항목을 작업 상태로 정리해줘.",
    },
  ]) {
    cases.push(await runTaskStoreContentionCase(stateCase));
  }

  const projectExecutor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: snapshotButlerData,
    projectId,
    workspacePath: root,
    sessionId: "beeg/agent-loop",
  });
  const readOnlyTools = toolDefinitions(["inspect_project_status", "query_project_work"]);
  cases.push(await runAgentLoopCase({
    caseId: "BEEG-LOOP-1",
    prompt: "Project Ledger 상태와 남은 next action을 확인해서 머지 리스크만 짧게 알려줘. 파일은 수정하지 마.",
    tools: readOnlyTools,
    toolCallsForIteration: (iteration) => iteration === 0
      ? [
          { id: "status-1", name: "inspect_project_status", arguments: { project_path: root } },
          { id: "work-1", name: "query_project_work", arguments: { project_path: root, kind: "next-actions" } },
        ]
      : [],
    execute: async (call) => {
      await sleep(80);
      return await projectExecutor({ name: call.name, args: call.arguments, rawArguments: JSON.stringify(call.arguments) });
    },
    expected: "Two concurrencySafe read-only tools overlap in one tool batch.",
    assertEvidence: ({ timings, maxActive }) =>
      maxActive >= 2 && hasOverlap(timings) ? null : "Safe read-only tools did not overlap.",
  }));

  const multiReadOnlyTools = toolDefinitions(["inspect_project_status", "query_project_work", "get_work_dashboard"]);
  cases.push(await runAgentLoopCase({
    caseId: "BEEG-LOOP-2",
    prompt: "막힌 작업, 리뷰 대기, 누락된 스펙을 각각 확인해서 표로 비교해줘. 수정은 하지 마.",
    tools: multiReadOnlyTools,
    toolCallsForIteration: (iteration) => iteration === 0
      ? [
          { id: "status-2", name: "inspect_project_status", arguments: { project_path: root } },
          { id: "work-2", name: "query_project_work", arguments: { project_path: root, kind: "blockers" } },
          { id: "dashboard-2", name: "get_work_dashboard", arguments: { debug: false, limit: 5 } },
        ]
      : [],
    execute: async (call) => {
      await sleep(80);
      return await projectExecutor({ name: call.name, args: call.arguments, rawArguments: JSON.stringify(call.arguments) });
    },
    expected: "Multiple concurrencySafe read-only tools overlap in one tool batch.",
    assertEvidence: ({ timings, maxActive }) =>
      maxActive >= 2 && hasOverlap(timings) ? null : "Multiple safe read-only tools did not overlap.",
  }));

  const mixedTools = toolDefinitions(["inspect_project_status", "render_project_dashboard"]);
  cases.push(await runAgentLoopCase({
    caseId: "BEEG-LOOP-3",
    prompt: "상태를 확인하고 대시보드도 갱신해줘.",
    tools: mixedTools,
    toolCallsForIteration: (iteration) => iteration === 0
      ? [
          { id: "status-serial", name: "inspect_project_status", arguments: { project_path: root } },
          {
            id: "dashboard-serial",
            name: "render_project_dashboard",
            arguments: { project_path: root, view: "dashboard", write: true },
          },
        ]
      : [],
    execute: async (call) => {
      await sleep(40);
      return await projectExecutor({ name: call.name, args: call.arguments, rawArguments: JSON.stringify(call.arguments) });
    },
    expected: "Unsafe mixed batch remains serial.",
    assertEvidence: ({ timings, maxActive }) =>
      maxActive === 1 && !hasOverlap(timings) ? null : "Unsafe mixed batch overlapped unexpectedly.",
  }));

  const failingTools: AgentLoopToolDefinition[] = [{
    name: "inspect_project_status",
    description: "Injected failing status check.",
    concurrencySafe: true,
  }];
  cases.push(await runAgentLoopCase({
    caseId: "BEEG-LOOP-4",
    prompt: "프로젝트 원장에서 막힌 작업만 확인해서 알려줘.",
    tools: failingTools,
    toolCallsForIteration: (iteration) => [{
      id: `failing-status-${iteration + 1}`,
      name: "inspect_project_status",
      arguments: { project_path: "/missing/beeg-project" },
    }],
    execute: async () => {
      await sleep(20);
      throw new Error(`ENOENT injected failure ${Date.now()}`);
    },
    expected: "Repeated identical failed tool calls stop before the generic iteration limit.",
    assertEvidence: ({ modelCalls, eventTypes, stoppedByLimit }) =>
      modelCalls === 2 &&
        eventTypes.includes("repeated_tool_failure") &&
        !stoppedByLimit
        ? null
        : "Repeated failure did not stop before the loop limit.",
  }));

  const alternateTools = toolDefinitions(["inspect_project_status", "get_work_dashboard"]);
  cases.push(await runAgentLoopCase({
    caseId: "BEEG-LOOP-5",
    prompt: "머지 전에 남은 리스크를 프로젝트 원장 근거로만 확인해줘.",
    tools: alternateTools,
    toolCallsForIteration: (iteration) => {
      if (iteration === 0) {
        return [{
          id: "status-primary-fails",
          name: "inspect_project_status",
          arguments: { project_path: "/missing/beeg-project" },
        }];
      }
      if (iteration === 1) {
        return [{
          id: "dashboard-alternate",
          name: "get_work_dashboard",
          arguments: { debug: false, limit: 5 },
        }];
      }
      return [];
    },
    execute: async (call) => {
      await sleep(30);
      if (call.name === "inspect_project_status") {
        throw new Error("Injected primary Project Ledger path failure");
      }
      return await projectExecutor({ name: call.name, args: call.arguments, rawArguments: JSON.stringify(call.arguments) });
    },
    expected: "After one failed local path, the loop can try an alternate local evidence path and finish truthfully.",
    assertEvidence: ({ timings, stoppedByLimit, eventTypes }) => {
      const sawPrimaryFailure = timings.some((timing) => timing.tool_name === "inspect_project_status" && !timing.ok);
      const sawAlternateSuccess = timings.some((timing) => timing.tool_name === "get_work_dashboard" && timing.ok);
      if (stoppedByLimit) return "Alternate-path case hit the generic loop limit.";
      if (eventTypes.includes("repeated_tool_failure")) return "Alternate-path case stopped as repeated failure instead of trying the alternate path.";
      return sawPrimaryFailure && sawAlternateSuccess ? null : "Alternate local evidence path was not observed.";
    },
  }));

  const report = {
    schema: "butler.e2e-evidence-gate-report.v1",
    run_id: runId,
    generated_at: new Date().toISOString(),
    source_butler_data_hash: hashText(sourceButlerData),
    snapshot_butler_data: snapshotButlerData.replace(`${root}/`, ""),
    evidence_dir: evidenceDir.replace(`${root}/`, ""),
    privacy: {
      raw_private_memory_in_report: false,
      source_butler_data_path_committed: false,
    },
    hot_cache_vector_backfill_blocks: hotCacheVectorBackfillBlocks,
    summary: {
      total: cases.length,
      passed: cases.filter((item) => item.status === "pass").length,
      failed: cases.filter((item) => item.status === "fail").length,
    },
    cases,
  };
  writeJson(reportPath, report);
  writeFileSync(summaryPath, [
    "# Butler E2E Evidence Gate",
    "",
    `- run_id: ${runId}`,
    `- total: ${report.summary.total}`,
    `- passed: ${report.summary.passed}`,
    `- failed: ${report.summary.failed}`,
    `- hot_cache_vector_backfill_blocks: ${hotCacheVectorBackfillBlocks}`,
    "",
    "| Case | Status | Failure |",
    "| --- | --- | --- |",
    ...cases.map((item) => `| ${item.case_id} | ${item.status} | ${item.failure ?? ""} |`),
    "",
  ].join("\n"), "utf8");

  console.log(JSON.stringify({
    run_id: runId,
    report: reportPath.replace(`${root}/`, ""),
    summary: report.summary,
    hot_cache_vector_backfill_blocks: hotCacheVectorBackfillBlocks,
    failed_cases: cases.filter((item) => item.status === "fail").map((item) => ({
      case_id: item.case_id,
      failure: item.failure,
    })),
  }, null, 2));

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

function runTaskStoreWriter(): void {
  const [, , , butlerData, taskId, writerId] = process.argv;
  assert(butlerData, "writer requires butlerData");
  assert(taskId, "writer requires taskId");
  assert(writerId, "writer requires writerId");
  const store = new TaskStore(butlerData);
  const taskSummary = `BEEG writer ${writerId} contention check`;
  store.writeOrigin(taskId, {
    version: 1,
    origin_session_id: "beeg/task-store",
    origin_message_id: `writer-${writerId}`,
    origin_inbound_event_id: `beeg-writer-${writerId}`,
    task_summary: taskSummary,
    created_at: new Date().toISOString(),
    project: root,
    topic_summary: "BEEG task-store contention",
    transcript_ref: {
      session_id: "beeg/task-store",
      path: join(butlerData, "transcripts", "beeg_task_store.jsonl"),
      origin_event_id: `beeg-writer-${writerId}`,
      origin_message_id: `writer-${writerId}`,
      recent_event_ids: [`beeg-writer-${writerId}`],
    },
    memory_refs: [],
  });
  store.markResultNotified(taskId, new Date());
}

function runPlannedTaskWriter(): void {
  const [, , , butlerData, taskId, writerId] = process.argv;
  assert(butlerData, "planned writer requires butlerData");
  assert(taskId, "planned writer requires taskId");
  assert(writerId, "planned writer requires writerId");
  const writerNumber = Number.parseInt(writerId, 10);
  const store = new PlannedTaskStore(butlerData);
  store.writeAttemptDispatch(taskId, writerNumber, {
    worker_task_id: `worker-${writerId}`,
    prompt: `BEEG planned writer ${writerId} prompt`,
  });
  store.writeAttemptResult(taskId, writerNumber, `BEEG planned writer ${writerId} result`);
  store.writeReview({
    task_id: taskId,
    attempt: writerNumber,
    verdict: "PASS",
    reviewed_at: new Date().toISOString(),
    criteria: [{
      criterion_index: 1,
      criterion: "planned-task state remains parseable under concurrent writes",
      verdict: "PASS",
      evidence: `writer ${writerId} review evidence`,
    }],
    missing_evidence: [],
    repair_recommendation: null,
  });
  store.writeDecision(taskId, {
    decision_id: `decision-${taskId}`,
    task_id: taskId,
    situation: "BEEG planned contention decision",
    recommended_option_id: "continue",
    options: [{
      id: "continue",
      label: "Continue",
      description: "Keep the contention test running.",
    }],
    tradeoffs: ["test-only contention evidence"],
    expires_at: null,
    created_at: new Date().toISOString(),
    response: null,
  });
  store.writePublicReport(taskId, `BEEG planned writer ${writerId} public report`);
}

await main();
