import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { AppGatewayBridge } from "../support/app-gateway-bridge.ts";
import { runNativeButlerMain } from "../../packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { BUTLER_TOOLS, createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { toolContractJsonChars } from "../../packages/butler-agent/src/agent/tools/profiles.ts";
import { indexTranscriptLinesForQuery } from "../../packages/butler-agent/src/agent/cognition/memory/exact-query.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import { runFunctionToolPromptText, runPromptText } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { providerCapabilitiesForModel } from "../../packages/butler-agent/src/integrations/providers/registry.ts";
import {
  readLocalModelConfigs,
  upsertLocalModelConfig,
} from "../../packages/butler-agent/src/integrations/providers/local/models.ts";
import {
  readRegisteredHostedModelConfigs,
  registerHostedModelConfig,
  resolveProviderCredentialSecret,
} from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { createProjectFolderSelectionToken } from "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAME_SET } from "../../packages/butler-agent/src/agent/tools/project-ledger/mutation-tools.ts";
import {
  collectElectronForwardProgressBenchmark,
  snapshotLedgerRecords,
  type ElectronForwardProgressBenchmark,
  type LedgerRecordSnapshot,
} from "../support/turn-forward-progress-electron-benchmark.ts";

const root = process.cwd();
const electronBin = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const electronAppRoot = resolve(root, "packages", "butler-app", "client", "electron");
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const tempDir = mkdtempSync(join(tmpdir(), "butler-app-client-multiturn-e2e-"));
const originalButlerData = process.env.BUTLER_DATA;
const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  originalButlerData ||
  join(process.env.HOME ?? "", ".butler");
const screenshotDir = resolve(root, ".tmp", "app-client-multiturn-e2e");
type E2eMode =
  | "deterministic"
  | "btcc-opening-decision"
  | "live-llm-btcc-opening-decision"
  | "tool-profile"
  | "live-llm"
  | "toolchain"
  | "live-llm-toolchain"
  | "live-llm-memory-recall"
  | "live-llm-beeg-autonomous"
  | "decision-context"
  | "live-llm-decision-context"
  | "live-llm-workstream"
  | "live-llm-workstream-natural"
  | "live-llm-real-project-check"
  | "live-llm-workstream-natural-external"
  | "live-llm-artifact-report"
  | "live-llm-watl-worker"
  | "live-llm-turn-forward-progress";
const requestedMode = process.env.BUTLER_APP_CLIENT_E2E_MODE;
const e2eMode: E2eMode = requestedMode === "live-llm"
  ? "live-llm"
  : requestedMode === "btcc-opening-decision"
    ? "btcc-opening-decision"
  : requestedMode === "live-llm-btcc-opening-decision"
    ? "live-llm-btcc-opening-decision"
  : requestedMode === "tool-profile"
    ? "tool-profile"
  : requestedMode === "toolchain"
    ? "toolchain"
    : requestedMode === "live-llm-toolchain"
      ? "live-llm-toolchain"
      : requestedMode === "live-llm-memory-recall"
        ? "live-llm-memory-recall"
      : requestedMode === "live-llm-beeg-autonomous"
        ? "live-llm-beeg-autonomous"
      : requestedMode === "decision-context"
        ? "decision-context"
        : requestedMode === "live-llm-decision-context"
          ? "live-llm-decision-context"
          : requestedMode === "live-llm-workstream"
            ? "live-llm-workstream"
          : requestedMode === "live-llm-workstream-natural"
            ? "live-llm-workstream-natural"
          : requestedMode === "live-llm-real-project-check"
            ? "live-llm-real-project-check"
          : requestedMode === "live-llm-workstream-natural-external"
            ? "live-llm-workstream-natural-external"
          : requestedMode === "live-llm-artifact-report"
            ? "live-llm-artifact-report"
          : requestedMode === "live-llm-watl-worker"
            ? "live-llm-watl-worker"
          : requestedMode === "live-llm-turn-forward-progress"
            ? "live-llm-turn-forward-progress"
          : "deterministic";
const usesLiveLlm = e2eMode === "live-llm" ||
  e2eMode === "live-llm-btcc-opening-decision" ||
  e2eMode === "live-llm-toolchain" ||
  e2eMode === "live-llm-memory-recall" ||
  e2eMode === "live-llm-beeg-autonomous" ||
  e2eMode === "live-llm-decision-context" ||
  e2eMode === "live-llm-workstream" ||
  e2eMode === "live-llm-workstream-natural" ||
  e2eMode === "live-llm-real-project-check" ||
  e2eMode === "live-llm-workstream-natural-external" ||
  e2eMode === "live-llm-artifact-report" ||
  e2eMode === "live-llm-watl-worker" ||
  e2eMode === "live-llm-turn-forward-progress";
const usesBtccOpeningDecisionScenario = e2eMode === "btcc-opening-decision" ||
  e2eMode === "live-llm-btcc-opening-decision";
const usesDeterministicBtccOpeningDecisionScenario = e2eMode === "btcc-opening-decision";
const usesDecisionContextScenario = e2eMode === "decision-context" || e2eMode === "live-llm-decision-context";
const usesDynamicDecisionContextScenario = e2eMode === "live-llm-decision-context";
const usesForwardProgressScenario = e2eMode === "live-llm-turn-forward-progress";
const usesExternalButlerService = e2eMode === "live-llm-workstream-natural-external" ||
  usesForwardProgressScenario;
const usesMemoryRecallScenario = e2eMode === "live-llm-memory-recall";
const usesBeegAutonomousScenario = e2eMode === "live-llm-beeg-autonomous";
const usesRealProjectCheckScenario = e2eMode === "live-llm-real-project-check";
const usesNaturalWorkStreamScenario = e2eMode === "live-llm-workstream-natural" ||
  usesRealProjectCheckScenario ||
  e2eMode === "live-llm-workstream-natural-external";
const usesWorkStreamScenario = e2eMode === "live-llm-workstream" || usesNaturalWorkStreamScenario;
const usesArtifactReportScenario = e2eMode === "live-llm-artifact-report";
const usesWatlWorkerScenario = e2eMode === "live-llm-watl-worker";
const usesDynamicWorkLabels = e2eMode === "live-llm-toolchain" ||
  usesDynamicDecisionContextScenario ||
  usesWorkStreamScenario ||
  usesArtifactReportScenario ||
  usesWatlWorkerScenario ||
  usesForwardProgressScenario;
const usesToolchainScenario = e2eMode === "toolchain" ||
  usesDeterministicBtccOpeningDecisionScenario ||
  e2eMode === "tool-profile" ||
  e2eMode === "live-llm-toolchain" ||
  usesDecisionContextScenario ||
  usesWorkStreamScenario ||
  usesArtifactReportScenario ||
  usesWatlWorkerScenario ||
  usesForwardProgressScenario;
const composerSelector = "[data-test-class~=\"composer-card\"]";
const composerTextareaSelector = `${composerSelector} textarea`;
const composerSendButtonSelector = `${composerSelector} button[type="submit"]`;
const assistantMessageSelector = "article[data-test-class~=\"message\"][data-test-class~=\"assistant\"]";
const turnActivityMessageSelector = "[data-test-class~=\"turn-activity-message\"]";
const markdownDocumentSelector = "[data-test-class~=\"markdown-document\"]";
const assistantFinalMarkdownSelector =
  `${assistantMessageSelector}:not(${turnActivityMessageSelector}) ${markdownDocumentSelector}`;
const turnActivityPanelSelector = "[data-test-class~=\"turn-activity-panel\"]";
const turnActivityCollapsedSelector = "[data-test-class~=\"turn-activity-collapsed\"]";
const todoComposerPanelSelector = "[data-test-class~=\"todo-composer-panel\"]";
const turnWorkPanelSelector = "[data-test-class~=\"turn-work-panel\"]";
const turnWorkCollapsedSelector = "[data-test-class~=\"turn-work-collapsed\"]";
const turnWorkCollapsedTriggerSelector = `${turnWorkCollapsedSelector} [role="button"]`;
const turnWorkBlockSelector = "[data-test-class~=\"turn-work-block\"]";
const turnWorkBlockHeaderSelector = "[data-test-class~=\"turn-work-block-header\"]";
const turnWorkToolRowSelector = "[data-test-class~=\"turn-work-tool-row\"]";
const turnWorkPanelBlockSelector = `${turnWorkPanelSelector} ${turnWorkBlockSelector}`;
const turnWorkCollapsedBlockSelector = `${turnWorkCollapsedSelector} ${turnWorkBlockSelector}`;
const turnWorkCollapsedHeaderSelector = `${turnWorkCollapsedSelector} ${turnWorkBlockHeaderSelector}`;
const turnResultSectionSelector = "[data-test-class~=\"turn-result-section\"]";
const composerModelButtonSelector = "[data-test-class~=\"model-button\"]";
const FIRST_RUN_STORAGE_KEY = "butler:first-run-setup:v1";
let liveClientModel = process.env.BUTLER_APP_CLIENT_E2E_MODEL?.trim();
let liveClientReasoning = process.env.BUTLER_APP_CLIENT_E2E_REASONING?.trim();
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TOOL_CALL_ARGUMENTS_TRANSCRIPT_SCHEMA = "butler.tool-call-arguments-transcript.v1";
const TOOL_RESULT_EVIDENCE_TRANSCRIPT_SCHEMA = "butler.tool-result-evidence-transcript.v1";
const BTCC_OPENING_DECISION_VISIBLE_THRESHOLD_MS = 250;
const BTCC_OPENING_DECISION_WAIT_GRACE_MS = 1_000;
const MOCK_OPENING_DECISION = {
  summary: "I will orient this deterministic app validation turn.",
  rationale: "You asked Butler to cover the opening decision stream with typed progress.",
  nextStep: "Start with a bounded local status step before continuing the report.",
} as const;
const MOCK_OPENING_DECISION_TEXT = JSON.stringify(MOCK_OPENING_DECISION);
const RAW_TOOL_RESULT_TRANSCRIPT_FIELDS = [
  "path",
  "content",
  "bytes",
  "before_sha256",
  "after_sha256",
  "sha256",
  "created",
  "overwritten",
  "atomic_write",
] as const;
const MEMORY_RECALL_TOKEN = `LIVE_E2E_RECALL_TOKEN_${runId}`;
const MEMORY_QUERY_FIRST_TEXT = `LIVE_E2E_FIRST_USER_MESSAGE_${runId}`;
const MEMORY_QUERY_SECOND_TEXT = `LIVE_E2E_SECOND_USER_MESSAGE_${runId}`;
const FIRST_FINAL = usesLiveLlm
  ? `LIVE_E2E_MEMORY_TOKEN_${runId}`
  : "FIRST_E2E_FINAL_VISIBLE_AND_DURABLE";
const SECOND_FINAL = usesLiveLlm
  ? `LIVE_E2E_SECOND_OK_${runId}`
  : "SECOND_E2E_CONFIRMED_FIRST_FINAL";
const MISSING_FINAL = usesLiveLlm
  ? `LIVE_E2E_MISSING_${runId}`
  : "SECOND_E2E_MISSING_FIRST_FINAL";
const TOOLCHAIN_FINAL = usesLiveLlm
  ? `LIVE_E2E_TOOLCHAIN_OK_${runId}`
  : `TOOLCHAIN_E2E_OK_${runId}`;
const toolchainProjectId = "toolchain-project";
const toolchainProjectDir = join(tempDir, toolchainProjectId);
const appDbPath = join(tempDir, "app.sqlite");
const toolchainDashboardPath = join(tempDir, "project-ledger", "projects", toolchainProjectId, "views", "dashboard.md");
const forwardProgressLedgerRoot = join(tempDir, "project-ledger", "projects", "butler");
const forwardProgressWorkspace = join(tempDir, "workspace", "butler");
const forwardProgressSessionTitle = "Forward Progress Benchmark";
const folderSelectionSecret = `e2e-folder-selection-${runId}`;
let forwardProgressLedgerBefore: LedgerRecordSnapshot = {};
let forwardProgressWorkspaceBefore: Record<string, string> = {};
let forwardProgressBenchmark: ElectronForwardProgressBenchmark | undefined;
let forwardProgressLiveBlocks = "";
let forwardProgressFirstMeaningfulMs = 0;
let forwardProgressTurnStartedAt = 0;
const artifactReportRelativePath = join(".tmp", "app-client-multiturn-e2e", `artifact-report-${runId}`);
const artifactReportDir = resolve(root, artifactReportRelativePath);
const artifactReportCsvRelativePath = join(
  artifactReportRelativePath,
  "korea_major_city_population_sample.csv",
);
const artifactReportCsvPath = resolve(root, artifactReportCsvRelativePath);
const workStreamCommandToken = `WORKSTREAM_E2E_COMMAND_${runId}`;
const requiredToolchainCalls = [
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
];
const requiredDecisionContextCalls = [
  "web_search",
  "web_read",
  "transform_public_data_table",
];
const expectedToolchainWorkBlockLabels = [
  "Project Ledger 상태 확인",
  "Reviewing the needed Project Ledger work context.",
  "Updating the Project Ledger dashboard.",
];
const expectedDecisionContextWorkBlockLabels = [
  "충주 공개 행사 데이터를 접근 가능한 출처에서 먼저 찾습니다.",
  "검색 후보 중 하나를 읽어 표에 넣을 날짜와 장소 필드를 확인합니다.",
  "확인한 행사 항목을 CSV 표로 정제합니다.",
];
const expectedToolchainProgressLabels = [
  "Checking local Project Ledger status",
  "Reviewing Project Ledger next actions",
  "Rendering Project Ledger dashboard view",
];
const expectedToolchainToolControlLabels = [
  "Project Ledger: status",
  "Project Ledger: next actions",
  "Project Ledger: dashboard view",
];
const expectedDecisionContextProgressLabels = [
  "Web search: 충주 행사 2026 공개 일정",
  "Reading public source: example.test",
  "Transforming public data table: 충주 공개 행사 표",
];
const activeWorkBlockLabels = usesDecisionContextScenario
  ? expectedDecisionContextWorkBlockLabels
  : expectedToolchainWorkBlockLabels;
const activeProgressLabels = usesDecisionContextScenario
  ? expectedDecisionContextProgressLabels
  : expectedToolchainProgressLabels;
const activeRequiredToolCalls = usesArtifactReportScenario
  ? ["web_search", "run_command"]
  : usesForwardProgressScenario
    ? []
  : usesWorkStreamScenario
    ? ["update_todo_list", "run_command"]
  : usesDynamicDecisionContextScenario
    ? ["web_search", "web_read", "write_file", "read_file"]
  : usesDecisionContextScenario
  ? requiredDecisionContextCalls
  : requiredToolchainCalls;
const toolchainPrompt = usesRealProjectCheckScenario
  ? [
    "지금 이 Butler 저장소를 머지하기 전에 한 번 봐줘.",
    "현재 브랜치, 작업트리 상태, 최근 커밋 몇 개를 확인해서 내가 지금 조심해야 할 리스크가 있는지 알려줘.",
    "필요하면 로컬 명령으로 확인해도 돼.",
    "답변은 브랜치, 변경 요약, 리스크, 다음 행동 네 항목으로 짧게 정리해줘.",
  ].join("\n")
  : usesForwardProgressScenario
  ? [
    "샌디의 브라우저 작업에서 사용자가 원하는 본문 요소를 모델이 직접 선택하고 캡처하는 web.capture 기능을 준비해 주세요.",
    "Project Ledger에 web.capture 관련 스펙, Work, 테스트 태스크 업데이트부터 해주세요. 기존 항목이 없으면 생성하고, 생성 또는 수정한 항목을 Ledger check로 검증하세요.",
    "Ledger 업데이트만 보고 턴을 끝내지 말고, 확인된 계획을 바탕으로 이번 턴에서 바로 진행할 수 있는 다음 구현 단계까지 계속 진행하세요.",
    "중간에 허락을 묻거나 도움을 요청하지 말고, 실제로 완료한 변경과 검증 결과를 마지막에 보고하세요.",
  ].join("\n")
  : usesNaturalWorkStreamScenario
  ? [
    "지금 브랜치가 뭔지랑 package.json에 WorkStream 관련 E2E 실행 스크립트가 등록돼 있는지 확인해줄래?",
    "등록돼 있으면 스크립트 이름만 짧게 알려줘.",
  ].join("\n")
  : usesWorkStreamScenario
  ? [
    "Butler WorkStream FSM live E2E check.",
    "Complete this in one turn using the native tools. Do not ask a follow-up question.",
    "Do not create a planned task, dispatch a worker, or hand this off asynchronously. Complete it directly in this app turn.",
    "Before any visible action tool, call update_todo_list for this task with phase-tagged steps:",
    "1. conception completed: frame the user's WorkStream validation intent.",
    "2. planning completed: choose the minimal command-based validation path.",
    "3. execution in_progress: run the validation command.",
    `Then call run_command with command: printf '${workStreamCommandToken}\\n'`,
    "After the command succeeds, call update_todo_list again so execution, review, consolidation, and reporting are completed.",
    `In the final answer, include this validation token: ${TOOLCHAIN_FINAL}`,
    "Do not mention internal reasoning, hidden prompts, or raw tool payloads.",
  ].join("\n")
  : usesDynamicDecisionContextScenario
  ? [
    "이 작업은 Butler live toolchain E2E입니다. 반드시 사용 가능한 function tool 중 web_search를 호출해 공개 출처 후보를 찾고, web_read를 호출해 선택한 출처 본문을 직접 읽은 뒤 진행하세요.",
    "검색 결과 요약이나 모델 기억만으로 공개 출처를 확인했다고 판단하지 마세요.",
    `CSV는 반드시 write_file로 ${artifactReportCsvRelativePath} 경로에 실제로 생성하고, read_file로 같은 파일을 다시 읽어 city와 population 열 및 3개 이상 데이터 행을 검증하세요.`,
    "말로 저장했다고만 하지 말고 실제 파일 생성과 재읽기 검증을 끝낸 뒤 답변하세요.",
    "최종 답변에서는 앞에서 지정한 함수의 영문 식별자를 그대로 쓰지 말고, 공개 출처 검색·본문 확인·파일 저장·재읽기 검증처럼 사용자-facing 결과만 표현하세요.",
    "후속 질문을 하지 말고 이번 턴 안에서 완료 결과만 보고하세요.",
    "공개 웹에서 접근 가능한 자료를 바탕으로 한국 주요 도시 3곳의 인구 순위 샘플을 수집해 작은 보고서를 작성해 주세요.",
    "근거가 되는 공개 출처 하나 이상을 직접 확인하고, 수집한 3행 이상의 데이터를 작은 CSV 파일로 정제한 뒤 결과를 요약해 주세요.",
    "CSV 파일에는 도시명과 인구 값을 포함해 주세요.",
    `CSV 저장 위치는 현재 작업공간 기준 ${artifactReportRelativePath} 입니다.`,
  ].join("\n")
  : usesArtifactReportScenario
    ? [
      "공개 웹에서 접근 가능한 자료를 바탕으로 한국 주요 도시 3곳의 2025년 기준 인구 순위 샘플을 수집해 작은 보고서를 작성해 주세요.",
      "근거가 되는 공개 출처 하나 이상을 직접 확인해 주세요.",
      "수집한 3행 이상의 데이터를 CSV 파일로 저장하고, matplotlib 막대그래프 PNG 파일도 실제로 생성해 주세요.",
      `저장 위치는 현재 작업공간 기준 ${artifactReportRelativePath} 입니다.`,
      "생성 후 파일이 실제로 존재하고 비어 있지 않은지도 확인한 뒤 결과를 요약해 주세요.",
    ].join("\n")
  : [
    usesDecisionContextScenario
      ? "Butler decision-context E2E medium data task."
      : "Local private Butler workspace E2E toolchain check.",
    "Complete the work in one turn. Use the available local Butler tools; do not ask the user a follow-up question.",
    ...(usesDecisionContextScenario
      ? [
        "Collect a small, easy public data sample about upcoming Chungju public events.",
        "Read one accessible public source candidate for evidence.",
        "Transform the collected rows into a CSV-style public data table with transform_public_data_table.",
        "Then write a concise outcome report based on the transformed table.",
      ]
      : [
        `1. Inspect local Project Ledger status for workspace path: ${toolchainProjectDir}`,
        `2. Query local Project Ledger work with kind: next-actions for workspace path: ${toolchainProjectDir}`,
        `3. Render the local Project Ledger dashboard with view: dashboard, write: true, workspace path: ${toolchainProjectDir}`,
      ]),
    "For every tool call, include a public work decision with summary/rationale/next_step fields.",
    ...(e2eMode === "live-llm-toolchain"
      ? [
        "Call exactly these three tools once each and in order: inspect_project_status, query_project_work, render_project_dashboard.",
        "Do not call run_command or any other verification tool. The render_project_dashboard write:true result is the durable evidence for this E2E.",
      ]
      : []),
    "In the final answer, report only the outcome. Do not list tool names, tool call order, or toolchain logs.",
    `When the tools finish, include this validation token in the final answer: ${TOOLCHAIN_FINAL}`,
  ].join("\n");
const firstPrompt = usesLiveLlm
  ? `This is a live Butler E2E check. Do not use tools. Reply with exactly this token and no other text: ${FIRST_FINAL}`
  : "first e2e turn";
const secondPrompt = usesLiveLlm
  ? [
    "This is turn two of the same live Butler E2E conversation.",
    "Do not use tools. Do not ask a follow-up question.",
    "Look only at the prior assistant message already present in the conversation history, not this instruction text.",
    "If that prior assistant message contains a token starting with LIVE_E2E_MEMORY_TOKEN_, reply exactly this token and no other text:",
    SECOND_FINAL,
    "If it does not, reply exactly this token and no other text:",
    MISSING_FINAL,
  ].join("\n")
  : "second e2e turn: use prior final";
const memoryRecallPrompt = [
  "실제 모델 메모리 회상/정확조회 E2E 확인입니다.",
  "먼저 recall_memory로 제가 메모리 엔진 도구 이름과 역할을 어떻게 나누자고 했는지 후보 기억을 확인해 주세요.",
  "그 다음 query_memory로 모든 세션에서 사용자 발화 기준 가장 이른 대화 1건을 정확히 조회해 주세요.",
  "run_command나 shell로 transcript 파일을 직접 뒤지지 마세요.",
  "최종 답변은 Answer line 1, Answer line 2, Exact first user message, Quality key를 각각 한 줄로만 답해주세요.",
  "Exact first user message 줄에는 query_memory 결과의 timestamp와 text를 반드시 함께 포함해 주세요.",
  `Quality key 줄에는 이 값을 그대로 포함해 주세요: ${MEMORY_RECALL_TOKEN}`,
].join("\n");
const beegAutonomousPrompt = [
  "버틀러에 저장된 예전 기억을 확인해서 답해줘.",
  "전에 웹 리더에서 본문 노이즈를 줄이는 방법을 얘기했잖아.",
  "그때 어떤 접근이 안전하다고 봤는지 확인된 범위에서 짧게 정리해줘.",
  "기억에서 확인되지 않은 내용은 단정하지 말아줘.",
].join("\n");
const waitForFinalTimeoutMs = usesForwardProgressScenario
  ? 900_000
  : usesLiveLlm
    ? 300_000
    : 20_000;

mkdirSync(screenshotDir, { recursive: true });
if (usesLiveLlm) {
  loadPrivateEnvIntoProcess(sourceButlerData);
  liveClientModel ||= process.env.BUTLER_APP_CLIENT_E2E_MODEL?.trim() || "openai/gpt-5.5";
  liveClientReasoning ||= process.env.BUTLER_APP_CLIENT_E2E_REASONING?.trim() || "medium";
  if (isGptHostedE2eModel(liveClientModel)) {
    assert(
      liveClientModel === "openai/gpt-5.5" || liveClientModel === "gpt-5.5",
      `live GPT E2E must use gpt-5.5, got ${liveClientModel}.`,
    );
    assert(
      liveClientReasoning === "low" || liveClientReasoning === "medium",
      `live GPT E2E reasoning must be low or medium, got ${liveClientReasoning}.`,
    );
  }
  process.env.BUTLER_RUNTIME ||= "codex-api";
  if (liveClientModel?.startsWith("local/")) copyLocalModelConfig(liveClientModel, sourceButlerData, tempDir);
  else if (liveClientModel) copyRegisteredHostedModelConfig(liveClientModel, sourceButlerData, tempDir);
}
process.env.BUTLER_DATA = tempDir;
if (usesMemoryRecallScenario) initializeMemoryRecallFixture();
if (usesBeegAutonomousScenario || usesWatlWorkerScenario) initializeBeegRealDataSnapshot();
if (usesForwardProgressScenario) {
  initializeForwardProgressLedger();
} else if (usesToolchainScenario && !usesArtifactReportScenario) {
  initializeToolchainProject();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function decisionIdFromResponseFormat(responseFormat: unknown): string {
  const schema = responseFormat && typeof responseFormat === "object"
    ? (responseFormat as { schema?: unknown }).schema
    : undefined;
  const properties = schema && typeof schema === "object"
    ? (schema as { properties?: unknown }).properties
    : undefined;
  const decision = properties && typeof properties === "object"
    ? (properties as { decision_id?: unknown }).decision_id
    : undefined;
  const decisionId = decision && typeof decision === "object"
    ? (decision as { const?: unknown }).const
    : undefined;
  assert(typeof decisionId === "string" && decisionId.length > 0, "typed decision id is missing from the response schema.");
  return decisionId;
}

assert(existsSync(electronBin), "Electron binary is missing; run npm --prefix packages/butler-app/client/electron install first.");
assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.");

let mockOpeningDecisionProviderCalls = 0;
let mockOpeningDecisionProviderLatencyMs: number | undefined;
let btccOpeningDecisionGate: Record<string, unknown> | undefined;

const fakeProvider: ModelProviderAdapter = {
  id: "mock-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  capabilitiesFor(model) {
    return providerCapabilitiesForModel(model);
  },
  async invoke(input) {
    if (input.metadata?.purpose === "app_opening_decision") {
      const startedAt = Date.now();
      assert(input.toolChoice === "none", "opening decision provider expected toolChoice=none.");
      assert(input.reasoning?.effort === "low", "opening decision provider expected low reasoning.");
      assert(!input.tools?.length, "opening decision provider must not receive tools.");
      mockOpeningDecisionProviderCalls += 1;
      if (usesLiveLlm) {
        const prompt = input.messages
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n\n");
        const text = await runPromptText({
          prompt,
          model: input.model,
          instructions: input.systemPrompt,
          responseFormat: input.responseFormat,
          reasoningEffort: input.reasoning?.effort ?? "low",
          signal: input.signal,
          cacheScope: "app-opening-decision-e2e",
        });
        mockOpeningDecisionProviderLatencyMs = Date.now() - startedAt;
        return { text };
      }
      mockOpeningDecisionProviderLatencyMs = Date.now() - startedAt;
      return {
        text: MOCK_OPENING_DECISION_TEXT,
        raw: { modelCallId: `mock-opening-${mockOpeningDecisionProviderCalls}` },
      };
    }
    return { text: "unused" };
  },
};

const prompts: string[] = [];
const observedToolCalls: string[] = [];
const observedToolSurfaces: Array<{
  count: number;
  contractJsonChars: number;
  names: string[];
}> = [];
let liveLlmCalls = 0;
const runtime = new NativeToolLoopRuntime({
  butlerHome: root,
  butlerData: tempDir,
  appMessageDbPath: appDbPath,
  disableAutomaticRecall: true,
  runPromptText: usesLiveLlm ? undefined : async (input) => {
    const decisionId = decisionIdFromResponseFormat(input.responseFormat);
    if (usesToolchainScenario) {
      return JSON.stringify({
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: decisionId,
        action: "inspect",
        target_workstream_id: null,
        target_project_id: null,
        blocker_id: null,
        deliverables: ["status_report"],
        answer_text: null,
        public_title: "Project Ledger 상태 확인",
        public_summary: "Project Ledger 상태와 다음 작업을 확인하고 대시보드를 갱신합니다.",
        public_rationale: "요청한 세 작업을 순서대로 실행해야 각 결과를 검증할 수 있습니다.",
        immediate_next_step: "먼저 현재 Project Ledger 상태를 조회합니다.",
      });
    }
    return JSON.stringify({
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: decisionId,
      action: "answer",
      target_workstream_id: null,
      target_project_id: null,
      blocker_id: null,
      deliverables: [],
      answer_text: prompts.length === 0 ? FIRST_FINAL : SECOND_FINAL,
      public_title: "요청에 답변",
      public_summary: "현재 대화 맥락으로 바로 답변합니다.",
      public_rationale: "추가 도구나 사용자 확인이 필요하지 않습니다.",
      immediate_next_step: null,
    });
  },
  executeButlerTool: usesLiveLlm ? undefined : async (call) => {
    if (e2eMode === "decision-context") {
      const deterministic = deterministicDecisionContextToolResult(call);
      if (deterministic) return deterministic;
    }
    return await createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      sessionId: "butler/app-general",
    })(call);
  },
  runFunctionToolPromptText: async (input) => {
    prompts.push(input.prompt);
    const toolNames = input.tools.map((tool) => tool.name);
    observedToolSurfaces.push({
      count: toolNames.length,
      contractJsonChars: toolContractJsonChars(input.tools),
      names: toolNames,
    });
    assertProfiledToolSurface(toolNames, input.tools);
    if (e2eMode === "decision-context") {
      await runDeterministicDecisionContext(input);
      return [
        "충주 공개 행사 자료를 확인하고 표 형태로 정제한 뒤 보고를 마쳤습니다.",
        TOOLCHAIN_FINAL,
      ].join("\n");
    }
    if (e2eMode === "toolchain" || e2eMode === "tool-profile" || usesDeterministicBtccOpeningDecisionScenario) {
      await runDeterministicToolchain(input);
      return [
        "Project Ledger check completed.",
        TOOLCHAIN_FINAL,
      ].join("\n");
    }
    if (usesLiveLlm) {
      liveLlmCalls += 1;
      return await runFunctionToolPromptText({
        ...input,
        executeTool: async (call) => {
          if (usesToolchainScenario) await delay(250);
          const result = await input.executeTool(call);
          observedToolCalls.push(call.name);
          return result;
        },
      });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
    if (prompts.length === 1) return FIRST_FINAL;
    return input.prompt.includes(FIRST_FINAL) ? SECOND_FINAL : MISSING_FINAL;
  },
});
const bridge = usesExternalButlerService
  ? null
  : new AppGatewayBridge({
      butlerHome: root,
      butlerData: tempDir,
      runtime,
      provider: fakeProvider,
      runtimePolicy: e2eRuntimePolicy(),
      ...(usesLiveLlm ? {} : { sessionTitleGenerator: false }),
    });
const server = createAppServer({
  dbPath: appDbPath,
  butlerData: tempDir,
  butlerHome: root,
  bridgeMode: usesExternalButlerService ? "external" : "local",
  port: 0,
  uiRoot,
  responderTimeoutMs: waitForFinalTimeoutMs + 30_000,
  automationSchedulerIntervalMs: false,
  responder: bridge?.responder,
  folderSelectionSecret,
});
if (usesForwardProgressScenario) {
  const project = server.store.createProject({
    source: "existing_folder",
    display_name: "Butler Forward Progress",
    folder_selection_token: createProjectFolderSelectionToken(
      forwardProgressWorkspace,
      folderSelectionSecret,
    ),
  }).project;
  server.store.createSession({
    kind: "project",
    project_id: project.id,
    title: forwardProgressSessionTitle,
  });
}
if (usesDeterministicBtccOpeningDecisionScenario) {
  server.store.updateSettings({
    model: "openai/gpt-5.5",
    reasoning_effort: "medium",
  });
}
if (usesLiveLlm && liveClientModel) {
  server.store.updateSettings({
    model: liveClientModel,
    reasoning_effort: isReasoningEffort(liveClientReasoning) ? liveClientReasoning : undefined,
  });
  assert(
    server.store.getSettings().model === liveClientModel,
    `live LLM E2E model setting did not persist: expected ${liveClientModel}, got ${server.store.getSettings().model}`,
  );
  const configPath = join(tempDir, "butler.config.json");
  const existingConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
    : {};
  const existingSystem = existingConfig.system && typeof existingConfig.system === "object" && !Array.isArray(existingConfig.system)
    ? existingConfig.system as Record<string, unknown>
    : {};
  writeFileSync(
    configPath,
    `${JSON.stringify({
      ...existingConfig,
      system: {
        ...existingSystem,
        runtime: "codex-api",
        butlerModel: liveClientModel,
        defaultModel: liveClientModel,
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function e2eRuntimePolicy(): Record<string, unknown> | undefined {
  if (usesLiveLlm) return undefined;
  return {
    completionReview: "disabled",
    ...(usesToolchainScenario
      ? {
        trackingMode: "ledger",
        tracking_mode_source: "explicit",
        requiredNativeToolProfiles: ["project"],
      }
      : {}),
  };
}

let electronProcess: ChildProcess | null = null;
let cdp: CdpClient | null = null;
const nativeShutdown = new AbortController();
const nativeService = usesExternalButlerService
  ? runNativeButlerMain({
      butlerHome: root,
      butlerData: tempDir,
      shutdownSignal: nativeShutdown.signal,
      shutdownPollMs: 250,
      workerResultPollMs: 500,
      enableTelegramPolling: false,
      waitForShutdown: true,
    })
  : null;
const output: string[] = [];

try {
  const debugPort = await freePort();
  const electronUserDataDir = join(tempDir, "electron-profile");
  electronProcess = spawn(electronBin, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${electronUserDataDir}`,
    electronAppRoot,
  ], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_APP_SERVER_URL: server.url,
      BUTLER_APP_UI_URL: server.url,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: electronUserDataDir,
      BUTLER_DATA: tempDir,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electronProcess.stdout?.on("data", (chunk) => output.push(String(chunk)));
  electronProcess.stderr?.on("data", (chunk) => output.push(String(chunk)));

  cdp = await connectToElectronPage(debugPort, server.url);
  await completeFirstRunSetupForE2e(cdp);
  await waitForVisible(cdp, composerTextareaSelector, "composer textarea");
  if (usesExternalButlerService && liveClientModel?.startsWith("local/")) {
    await waitForComposerModel(cdp, liveClientModel);
  }

  if (usesMemoryRecallScenario) {
    await runMemoryRecallBrowserScenario(cdp);
  } else if (usesWatlWorkerScenario) {
    await runWatlWorkerBrowserScenario(cdp);
  } else if (usesBeegAutonomousScenario) {
    await runBeegAutonomousBrowserScenario(cdp);
  } else if (usesToolchainScenario) {
    await runToolchainBrowserScenario(cdp);
  } else {
    await runMultiturnBrowserScenario(cdp);
  }
  await assertCanonicalSessionSnapshot(cdp, "before-reload");
  await reloadElectronPageAndAssertStable(cdp);
  await assertCanonicalSessionSnapshot(cdp, "after-reload");
  if (usesForwardProgressScenario) {
    await expandCollapsedTurnActivity(cdp);
    const replayBlocks = await visibleWorkBlockSnapshot(cdp);
    assert(
      replayBlocks === forwardProgressLiveBlocks,
      `forward-progress live/replay work blocks differ: live=${forwardProgressLiveBlocks} replay=${replayBlocks}`,
    );
    forwardProgressBenchmark = await finalizeForwardProgressBenchmark(true);
    assertForwardProgressLedgerShape(forwardProgressBenchmark.changedLedgerRecords);
    assert(
      forwardProgressBenchmark.gate.ok,
      `forward-progress benchmark gates failed: ${forwardProgressBenchmark.gate.failures.join(", ")}; benchmark=${JSON.stringify(forwardProgressBenchmark)}`,
    );
  }

  const screenshotFile = `${e2eMode}-final.png`;
  const screenshotPath = join(screenshotDir, screenshotFile);
  await captureScreenshot(cdp, screenshotPath);
  assert(statSync(screenshotPath).size > 8_000, "final e2e screenshot is unexpectedly small.");
  const decisionSourceCounts = await replayDecisionSourceCounts();
  const workStreamEvidence = usesWorkStreamScenario ? readWorkStreamEvidence() : [];
  if (usesWorkStreamScenario) assertWorkStreamEvidence(workStreamEvidence);
  if (usesExternalButlerService) assertExternalButlerServiceEvidence();

  console.log(JSON.stringify({
    ok: true,
    service: "butler-app-client-multiturn-e2e",
    mode: e2eMode,
    checks: [
      "electron-client-booted",
      "live-turn-activity-visible",
      "runtime-turn-events-replayed",
      "canonical-session-view-consistent",
      "electron-reload-preserved-session-state",
      ...(usesToolchainScenario
        ? ["work-blocks-visible", "final-work-collapsed", "result-isolated"]
        : usesMemoryRecallScenario || usesBeegAutonomousScenario
        ? ["memory-recall-final-visible"]
        : ["status-only-final-activity-hidden"]),
      ...(usesForwardProgressScenario
        ? [
          "real-llm-provider-called",
          "isolated-canonical-ledger-mutated",
          "spec-work-test-task-updated",
          "single-opening-decision",
          "linear-work-blocks",
          "live-replay-work-block-parity",
          "forward-progress-performance-gates",
        ]
        : usesToolchainScenario
        ? [
          ...(e2eMode === "tool-profile"
            ? ["provider-tool-surface-profiled", "weather-tools-excluded-from-provider-surface"]
            : []),
          "single-prompt-multi-toolchain",
          ...(usesDecisionContextScenario
            ? ["public-decision-context-toolchain", "public-data-csv-output"]
            : ["project-ledger-read-write-toolchain"]),
          ...(e2eMode === "live-llm-toolchain" || e2eMode === "live-llm-decision-context"
            ? ["real-llm-provider-called", "default-goal-completion-gate"]
            : []),
          ...(usesWorkStreamScenario
            ? [
              usesExternalButlerService ? "external-butler-service-live-model-path" : "real-llm-provider-called",
              "butler-workstream-created",
              "workstream-fsm-progressed",
              ...(usesRealProjectCheckScenario ? ["real-project-check-use-case"] : []),
              ...(usesNaturalWorkStreamScenario ? ["natural-workstream-use-case"] : []),
              ...(usesExternalButlerService
                ? ["external-butler-service-processed-inbound", "app-transport-final-delivered"]
                : []),
            ]
            : []),
          ...(usesArtifactReportScenario
            ? ["real-llm-provider-called", "command-generated-artifacts", "default-goal-completion-gate"]
            : []),
          ...(usesWatlWorkerScenario
            ? ["real-llm-provider-called", "electron-natural-worker-prompt", "worker-activity-timeline-evidence", "worker-implementation-evidence"]
            : []),
        ]
        : usesMemoryRecallScenario
        ? [
          "real-llm-provider-called",
          "recall-memory-tool-called",
          "query-memory-tool-called",
          "run-command-not-used-for-memory-query",
          "seeded-memory-quality-token-recalled",
          "exact-first-user-message-verified",
        ]
        : usesBeegAutonomousScenario
        ? [
          "real-llm-provider-called",
          "natural-prompt-used",
          "autonomous-recall-memory-tool-called",
          "vector-diagnostics-observed",
          "raw-private-memory-not-reported",
        ]
        : [
          "composer-two-turn-flow",
          "durable-final-transcript-continuity",
          ...(e2eMode === "live-llm" ? ["real-llm-provider-called"] : []),
        ]),
    ],
    toolCalls: observedToolCalls,
    toolSurfaces: observedToolSurfaces,
    globalToolSurface: {
      count: BUTLER_TOOLS.length,
      contractJsonChars: toolContractJsonChars(BUTLER_TOOLS),
    },
    durableToolCalls: usesBeegAutonomousScenario
      ? durableTranscriptToolCalls(latestE2eSessionId())
      : durableTranscriptToolCalls(),
    memoryRecall: usesMemoryRecallScenario ? readMemoryRecallEvidence() : undefined,
    beegAutonomous: usesBeegAutonomousScenario ? readBeegAutonomousEvidence() : undefined,
    watlWorker: usesWatlWorkerScenario ? readWatlWorkerEvidence() : undefined,
    forwardProgress: usesForwardProgressScenario ? forwardProgressBenchmark : undefined,
    btccOpeningDecision: usesBtccOpeningDecisionScenario ? btccOpeningDecisionGate : undefined,
    inboundQueue: usesExternalButlerService ? inboundQueueCounts() : undefined,
    decisionSourceCounts,
    workStreams: workStreamEvidence,
    llmCalls: liveLlmCalls,
    requestedModel: usesLiveLlm ? liveClientModel : undefined,
    model: usesLiveLlm ? server.store.getSettings().model : undefined,
    runtimeBindingModels: usesLiveLlm ? runtimeBindingModels() : undefined,
    screenshot: `.tmp/app-client-multiturn-e2e/${screenshotFile}`,
  }));
} catch (error) {
  const details = output.join("").trim();
  const bodyPreview = cdp
    ? await evaluateString(cdp, "document.body.innerText").catch(() => "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = [
    message,
    details,
    bodyPreview ? `BODY PREVIEW:\n${bodyPreview.slice(0, 4_000)}` : "",
  ].filter(Boolean).join("\n");
  throw new Error(diagnostic, { cause: error });
} finally {
  cdp?.close();
  stopElectron();
  server.stop();
  nativeShutdown.abort();
  if (nativeService) {
    await Promise.race([
      nativeService.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  bridge?.close();
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (process.env.BUTLER_APP_CLIENT_E2E_KEEP_TEMP === "1") {
    redactE2eProviderCredentialSecrets(tempDir);
    console.error(`Preserved E2E temp dir: ${tempDir}`);
  } else {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function initializeToolchainProject(): void {
  mkdirSync(toolchainProjectDir, { recursive: true });
  const result = spawnSync(process.execPath, [
    join(root, "packages", "project-ledger", "bin", "project-ledger"),
    "init",
    "--project",
    toolchainProjectDir,
    "--id",
    "e2e-toolchain",
    "--name",
    "E2E Toolchain",
    "--json",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_DATA: tempDir,
      BUTLER_HOME: root,
    },
  });
  assert(
    result.status === 0,
    `failed to initialize isolated Project Ledger fixture: ${result.stderr || result.stdout}`,
  );
}

function initializeForwardProgressLedger(): void {
  const source = join(sourceButlerData, "project-ledger", "projects", "butler");
  assert(existsSync(source), `source Butler Project Ledger does not exist: ${source}`);
  rmSync(forwardProgressLedgerRoot, { recursive: true, force: true });
  mkdirSync(join(tempDir, "project-ledger", "projects"), { recursive: true });
  cpSync(source, forwardProgressLedgerRoot, { recursive: true, force: true });
  mkdirSync(join(forwardProgressWorkspace, "src"), { recursive: true });
  writeFileSync(join(forwardProgressWorkspace, "package.json"), `${JSON.stringify({
    name: "butler-forward-progress-e2e",
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(forwardProgressWorkspace, "src", "browser-capture.ts"), [
    "export interface BrowserCaptureRequest {",
    "  url: string;",
    "  selector?: string;",
    "}",
    "",
    "export function planBrowserCapture(request: BrowserCaptureRequest): BrowserCaptureRequest {",
    "  return request;",
    "}",
    "",
  ].join("\n"), "utf8");
  forwardProgressWorkspaceBefore = snapshotTextFiles(forwardProgressWorkspace);
  forwardProgressLedgerBefore = snapshotLedgerRecords(forwardProgressLedgerRoot);
  assert(
    Object.keys(forwardProgressLedgerBefore).length > 0,
    "isolated forward-progress Ledger snapshot is empty.",
  );
}

function initializeMemoryRecallFixture(): void {
  const hotDir = join(tempDir, "cognition", "memory", "hot");
  mkdirSync(hotDir, { recursive: true });
  writeFileSync(join(hotDir, "live-recall-e2e.md"), [
    "# Live Recall E2E Memory",
    "",
    "- Decision: the current associative memory tool is recall_memory.",
    "- Input field: cue.",
    "- Boundary: query_memory is the exact durable memory/history lookup tool.",
    "- Evidence ladder: recall_memory finds anchors; query_memory verifies dates, counts, earliest, and latest claims.",
    "- Answer line 1: recall_memory: current associative recall tool; input field cue; returns candidate memory evidence.",
    "- Answer line 2: query_memory: exact durable memory/history lookup tool for dates, counts, earliest, and latest claims.",
    `- Quality key: ${MEMORY_RECALL_TOKEN}`,
    "- This memory is candidate recall evidence, not verified chronological truth.",
  ].join("\n"), "utf8");
  indexTranscriptLinesForQuery({
    butlerData: tempDir,
    transcriptFile: "synthetic-live-e2e.jsonl",
    lines: [
      JSON.stringify({
        eventId: "live-e2e-tool-result-must-not-count",
        sessionId: "butler/main",
        kind: "tool_result",
        timestamp: "2026-04-24T11:00:00.000Z",
        payload: { name: "run_command", result: "ignore this tool payload" },
      }),
      JSON.stringify({
        eventId: "live-e2e-first-user-message",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-24T12:05:34.000Z",
        payload: { message: { text: MEMORY_QUERY_FIRST_TEXT } },
      }),
      JSON.stringify({
        eventId: "live-e2e-intro-user-message",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-24T12:27:10.000Z",
        payload: { message: { text: MEMORY_QUERY_SECOND_TEXT } },
      }),
    ],
  });
}

function initializeBeegRealDataSnapshot(): void {
  assert(existsSync(sourceButlerData), `source Butler data does not exist: ${sourceButlerData}`);
  const result = spawnSync("rsync", [
    "-a",
    "--delete",
    "--exclude",
    "runtime/",
    "--exclude",
    "*.sock",
    `${sourceButlerData.replace(/\/$/u, "")}/`,
    `${tempDir}/`,
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert(
    result.status === 0,
    `failed to copy real Butler data snapshot for live worker Electron E2E: ${result.stderr || result.stdout}`,
  );
  rmSync(appDbPath, { force: true });
}

function copyLocalModelConfig(modelRef: string, source: string, target: string): void {
  const model = readLocalModelConfigs(source)
    .find((candidate) => candidate.model_ref === modelRef || candidate.model_id === modelRef.replace(/^local\//u, ""));
  if (!model) throw new Error(`local model ${modelRef} is not registered in source Butler data`);
  upsertLocalModelConfig({
    serverUrl: model.server_url,
    apiType: model.api_type,
    platform: model.platform,
    modelId: model.model_id,
    displayName: model.display_name,
    contextWindowTokens: model.context_window_tokens,
    maxOutputTokens: model.max_output_tokens,
    reasoningBudgetRatio: model.reasoning_budget_ratio,
    source: model.source,
  }, target);
}

function copyRegisteredHostedModelConfig(modelRef: string, source: string, target: string): void {
  const requestedModelId = modelRef.includes("/") ? modelRef.split("/").pop() : modelRef;
  const model = readRegisteredHostedModelConfigs(source)
    .find((candidate) => candidate.model_ref === modelRef || candidate.model_id === requestedModelId);
  if (!model) return;
  if (model.auth_type === "codex_oauth") {
    registerHostedModelConfig({
      providerId: model.provider_id,
      modelId: model.model_id,
      displayName: model.display_name,
      authType: "codex_oauth",
      apiBaseUrl: model.api_base_url,
    }, target);
    return;
  }
  const apiKey = resolveProviderCredentialSecret(model.credential_id, model.provider_id, source);
  if (!apiKey) throw new Error(`registered hosted model ${model.model_ref} is missing a source credential`);
  registerHostedModelConfig({
    providerId: model.provider_id,
    modelId: model.model_id,
    displayName: model.display_name,
    authType: "api_key",
    apiKey,
    credentialLabel: `${model.display_name} E2E`,
    apiBaseUrl: model.api_base_url,
  }, target);
}

function redactE2eProviderCredentialSecrets(target: string): void {
  const credentialPath = join(target, "auth", "model-provider-credentials.json");
  if (!existsSync(credentialPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(credentialPath, "utf8")) as Record<string, unknown>;
    const credentials = Array.isArray(parsed.credentials) ? parsed.credentials : [];
    writeFileSync(credentialPath, `${JSON.stringify({
      ...parsed,
      credentials: credentials.map((credential) => {
        if (!credential || typeof credential !== "object" || Array.isArray(credential)) return credential;
        return {
          ...credential,
          secret: "[redacted-by-e2e-harness]",
        };
      }),
    }, null, 2)}\n`, "utf8");
  } catch {
    rmSync(credentialPath, { force: true });
  }
}

function readWorkStreamEvidence(): Array<Record<string, unknown>> {
  const dir = join(tempDir, "work-streams");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(join(dir, entry), "utf8")) as Record<string, unknown>)
    .map((record) => ({
      id: record.id,
      title: record.title,
      owner_session_id: record.owner_session_id,
      project_id: record.project_id,
      state: record.state,
      current_phase: record.current_phase,
      active_step_id: record.active_step_id,
      todo_list_id: record.todo_list_id,
      linked_worker_task_ids: record.linked_worker_task_ids,
      linked_orchestration_ids: record.linked_orchestration_ids,
      linked_planned_task_ids: record.linked_planned_task_ids,
    }));
}

function readRuntimeToolCalls(): string[] {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return observedToolCalls;
  const transcriptCalls = readdirSync(dir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .flatMap((entry) => readFileSync(join(dir, entry), "utf8").split(/\n/u))
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const payload = record.payload as Record<string, unknown> | undefined;
        return record.kind === "tool_call" && typeof payload?.name === "string"
          ? [payload.name]
          : [];
      } catch {
        return [];
      }
    });
  return [...observedToolCalls, ...transcriptCalls];
}

function assertWorkStreamEvidence(records: Array<Record<string, unknown>>): void {
  const runtimeToolCalls = readRuntimeToolCalls();
  assert(records.length > 0, "live WorkStream E2E did not create a durable WorkStream record.");
  const record = records.find((candidate) =>
    typeof candidate.owner_session_id === "string" &&
    candidate.owner_session_id.startsWith("butler/app-"),
  ) ?? records[0];
  assert(
    record.state === "complete" || (record.state !== "routing" && record.current_phase !== null),
    `live WorkStream E2E did not advance beyond routing: ${JSON.stringify(records)}`,
  );
  assert(
    record.state === "complete",
    `live WorkStream E2E did not complete the durable WorkStream: ${JSON.stringify(records)}`,
  );
  assert(
    runtimeToolCalls.includes("update_todo_list"),
    `live WorkStream E2E did not call update_todo_list: ${runtimeToolCalls.join(" -> ")}`,
  );
  assert(
    runtimeToolCalls.includes("run_command"),
    `live WorkStream E2E did not call run_command: ${runtimeToolCalls.join(" -> ")}`,
  );
}

function inboundQueueCounts(): Record<"pending" | "processing" | "processed" | "failed", number> {
  const rootDir = join(tempDir, "runtime", "inbound-events");
  const count = (name: "pending" | "processing" | "processed" | "failed") => {
    const dir = join(rootDir, name);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((entry) => entry.endsWith(".json")).length;
  };
  return {
    pending: count("pending"),
    processing: count("processing"),
    processed: count("processed"),
    failed: count("failed"),
  };
}

function assertExternalButlerServiceEvidence(): void {
  const queue = inboundQueueCounts();
  assert(
    queue.processed >= 1,
    `external Butler service did not process the app inbound queue: ${JSON.stringify(queue)}`,
  );
  assert(queue.failed === 0, `external Butler service failed queued inbound events: ${JSON.stringify(queue)}`);
  assert(queue.pending === 0, `external Butler service left app inbound events pending: ${JSON.stringify(queue)}`);
  assert(
    durableAppOutboundExists(),
    "external Butler service did not deliver a durable app outbound final message.",
  );
  assert(
    runtimeBindingModels().some((binding) => binding.modelRef === liveClientModel),
    `external Butler service did not use the requested live model binding: ${JSON.stringify(runtimeBindingModels())}`,
  );
}

function runtimeBindingModels(): Array<{ sessionId: string; modelRef: string; providerId: string }> {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  try {
    return store.listSessions().map((binding) => ({
      sessionId: binding.sessionId,
      modelRef: binding.modelRef,
      providerId: binding.modelProviderId,
    }));
  } finally {
    store.close();
  }
}

function isReasoningEffort(value: string | undefined): value is "none" | "low" | "medium" | "high" | "xhigh" {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isGptHostedE2eModel(value: string | undefined): boolean {
  if (!value) return false;
  return value === "gpt-5.5" || value.startsWith("openai/gpt-");
}

function assertProfiledToolSurface(
  toolNames: string[],
  tools: Parameters<typeof runFunctionToolPromptText>[0]["tools"],
): void {
  const forbiddenWeatherTools = [
    "get_weather_with_knowhow",
    "record_weather_source_feedback",
    "run_weather_knowhow_consolidation",
  ];
  for (const name of forbiddenWeatherTools) {
    assert(!toolNames.includes(name), `provider-facing tool surface unexpectedly included weather tool: ${name}`);
  }
  assert(
    toolNames.length < BUTLER_TOOLS.length,
    `provider-facing tool surface was not profiled: ${toolNames.length}/${BUTLER_TOOLS.length}`,
  );
  assert(
    toolContractJsonChars(tools) < toolContractJsonChars(BUTLER_TOOLS),
    "provider-facing tool contract JSON was not smaller than the global Butler registry.",
  );
}

async function runDeterministicToolchain(
  input: Parameters<typeof runFunctionToolPromptText>[0],
): Promise<void> {
  const toolNames = workBlockCatalogNames(input.tools);
  for (const name of requiredToolchainCalls) {
    assert(
      toolNames.includes(name),
      `deterministic toolchain provider surface did not include required tool: ${name}; available=${toolNames.join(",")}`,
    );
  }
  for (const [index, name] of requiredToolchainCalls.entries()) {
    const args = deterministicToolchainArgs(name);
    await input.onAssistantTextBeforeTools?.({
      text: [
        `title: ${expectedToolchainWorkBlockLabels[index]}`,
        `summary: ${expectedToolchainProgressLabels[index]} 작업을 수행합니다.`,
        "rationale: 요청한 Project Ledger 검증은 단계별 도구 결과를 관찰해야 안전하게 진행됩니다.",
        `next_step: ${expectedToolchainProgressLabels[index]}.`,
        `expected_effect: ${expectedToolchainProgressLabels[index]} 결과가 다음 단계의 근거로 남습니다.`,
      ].join("\n"),
      toolCalls: [{ name, args }],
    });
    await input.executeTool({
      name,
      args,
      rawArguments: JSON.stringify(args),
    });
    observedToolCalls.push(name);
    await delay(300);
  }
}

function workBlockCatalogNames(
  tools: readonly { name: string; description?: string; parameters: Record<string, unknown> }[],
): string[] {
  const wrapper = tools.find((tool) => tool.name === "run_work_block");
  if (!wrapper) return tools.map((tool) => tool.name);
  const properties = wrapper.parameters.properties as Record<string, unknown> | undefined;
  const calls = properties?.calls as { items?: unknown } | undefined;
  const items = calls?.items as { oneOf?: unknown[] } | undefined;
  const variants = Array.isArray(items?.oneOf) ? items.oneOf : items ? [items] : [];
  const names = variants.flatMap((variant) => {
    const name = (variant as { properties?: { name?: { const?: unknown } } })
      .properties?.name?.const;
    return typeof name === "string" ? [name] : [];
  });
  if (names.length > 0) return names;
  const available = wrapper.description?.match(/Available calls: ([^.]+)\./u)?.[1];
  return available
    ? available.split(",").map((name) => name.trim()).filter(Boolean)
    : [];
}

function deterministicToolchainArgs(name: string): Record<string, unknown> {
  if (name === "inspect_project_status") {
    return { project_path: toolchainProjectDir };
  }
  if (name === "query_project_work") {
    return { project_path: toolchainProjectDir, kind: "next-actions" };
  }
  return { project_path: toolchainProjectDir, view: "dashboard", write: true };
}

async function runDeterministicDecisionContext(
  input: Parameters<typeof runFunctionToolPromptText>[0],
): Promise<void> {
  await input.onAssistantTextBeforeTools?.({
    text: [
      `작업: ${expectedDecisionContextWorkBlockLabels[0]}`,
      "이유: 중형 작업의 보고가 임의 지식이 아니라 공개 자료 수집에서 시작되는지 검증해야 합니다.",
      "다음: 검색 결과에서 읽을 수 있는 출처 후보를 고릅니다.",
    ].join("\n"),
    toolCalls: [{
      name: "web_search",
      args: { query: "충주 행사 2026 공개 일정", max_results: 3 },
    }],
  });
  await input.executeTool({
    name: "web_search",
    args: { query: "충주 행사 2026 공개 일정", max_results: 3 },
    rawArguments: JSON.stringify({ query: "충주 행사 2026 공개 일정", max_results: 3 }),
  });
  observedToolCalls.push("web_search");

  await input.onAssistantTextBeforeTools?.({
    text: [
      `작업: ${expectedDecisionContextWorkBlockLabels[1]}`,
      "이유: 검색 요약만으로는 표에 넣을 항목과 필드가 충분히 안정적이지 않습니다.",
      "다음: 읽은 내용을 행사명, 날짜, 장소 열로 정리합니다.",
    ].join("\n"),
    toolCalls: [{
      name: "web_read",
      args: { url: "https://example.test/chungju-events", max_chars: 1200 },
    }],
  });
  await input.executeTool({
    name: "web_read",
    args: { url: "https://example.test/chungju-events", max_chars: 1200 },
    rawArguments: JSON.stringify({ url: "https://example.test/chungju-events", max_chars: 1200 }),
  });
  observedToolCalls.push("web_read");

  await input.onAssistantTextBeforeTools?.({
    text: [
      `작업: ${expectedDecisionContextWorkBlockLabels[2]}`,
      "이유: 최종 보고 전에 수집한 데이터를 행과 열로 고정해야 누락과 중복을 확인할 수 있습니다.",
      "다음: 정제된 CSV 미리보기를 기준으로 결과를 요약합니다.",
    ].join("\n"),
    toolCalls: [{
      name: "transform_public_data_table",
      args: {
        title: "충주 공개 행사 표",
        columns: ["event", "date", "place", "source"],
        rows: deterministicPublicEventRows(),
      },
    }],
  });
  await input.executeTool({
    name: "transform_public_data_table",
    args: {
      title: "충주 공개 행사 표",
      columns: ["event", "date", "place", "source"],
      rows: deterministicPublicEventRows(),
    },
    rawArguments: JSON.stringify({
      title: "충주 공개 행사 표",
      columns: ["event", "date", "place", "source"],
      rows: deterministicPublicEventRows(),
    }),
  });
  observedToolCalls.push("transform_public_data_table");
}

function deterministicDecisionContextToolResult(call: {
  name: string;
  args: Record<string, unknown>;
}): Record<string, unknown> | null {
  if (call.name === "web_search") {
    return {
      ok: true,
      provider: "deterministic",
      query: call.args.query,
      results: [{
        title: "충주시 행사 안내",
        url: "https://example.test/chungju-events",
        snippet: "충주 공개 행사 일정과 장소를 제공하는 접근 가능한 페이지입니다.",
      }],
      citation_required: true,
      source_urls: ["https://example.test/chungju-events"],
    };
  }
  if (call.name === "web_read") {
    return {
      ok: true,
      url: call.args.url,
      title: "충주시 행사 안내",
      markdown: [
        "# 충주시 행사 안내",
        "- 행사: 중앙탑 야외 음악회 / 날짜: 2026-05-10 / 장소: 중앙탑공원",
        "- 행사: 탄금호 생활문화 장터 / 날짜: 2026-05-11 / 장소: 탄금호 일원",
      ].join("\n"),
      chunks: [{
        title: "행사 목록",
        text: "중앙탑 야외 음악회와 탄금호 생활문화 장터의 날짜와 장소가 안내되어 있습니다.",
      }],
    };
  }
  return null;
}

function deterministicPublicEventRows(): Array<Record<string, string>> {
  return [
    {
      event: "중앙탑 야외 음악회",
      date: "2026-05-10",
      place: "중앙탑공원",
      source: "충주시 행사 안내",
    },
    {
      event: "탄금호 생활문화 장터",
      date: "2026-05-11",
      place: "탄금호 일원",
      source: "충주시 행사 안내",
    },
  ];
}

async function runMultiturnBrowserScenario(client: CdpClient): Promise<void> {
  await sendComposerTurn(client, firstPrompt);
  if (usesBtccOpeningDecisionScenario) {
    await waitForBtccOpeningDecisionVisible(
      client,
      usesLiveLlm ? undefined : BTCC_OPENING_DECISION_VISIBLE_THRESHOLD_MS,
    );
  }
  await waitForVisibleOrAssistantFinalText(client, turnActivityPanelSelector, "live turn activity", FIRST_FINAL);
  await waitForAssistantFinalText(client, FIRST_FINAL, waitForFinalTimeoutMs);
  await assertNoVisibleStatusOnlyFinalActivity(client);

  assert(
    durableTranscriptContains(FIRST_FINAL),
    "first final answer was visible but absent from durable runtime transcript.",
  );
  const firstTurnEventKinds = await replayAgentTurnEventKinds();
  for (const kind of ["turn.iteration.started", "guard.started", "message.final.completed", "turn.completed"]) {
    assert(firstTurnEventKinds.includes(kind), `runtime turn event was not replayed through the app server: ${kind}`);
  }

  await sendComposerTurn(client, secondPrompt);
  await waitForAnyAssistantFinalText(client, [SECOND_FINAL, MISSING_FINAL], waitForFinalTimeoutMs);
  const secondPromptContainsFirstFinal = prompts[1]?.includes(FIRST_FINAL) ?? false;
  assert(secondPromptContainsFirstFinal, liveDiagnostics("second runtime prompt did not include the first final answer."));
  assert(!(await assistantFinalTextIncludes(client, MISSING_FINAL)), liveDiagnostics("second final rendered the failure sentinel."));
  await waitForAssistantFinalText(client, SECOND_FINAL, waitForFinalTimeoutMs);
  await assertNoVisibleStatusOnlyFinalActivity(client);
  if (e2eMode === "live-llm") {
    assert(liveLlmCalls >= 2, `expected at least 2 real LLM calls, observed ${liveLlmCalls}.`);
    assert(
      await assistantFinalTextIncludes(client, FIRST_FINAL),
      "second live LLM turn did not render or preserve the first final token.",
    );
  }
}

async function runMemoryRecallBrowserScenario(client: CdpClient): Promise<void> {
  await sendComposerTurn(client, memoryRecallPrompt);
  await waitForVisibleOrAssistantFinalText(
    client,
    turnActivityPanelSelector,
    "live memory recall activity",
    MEMORY_RECALL_TOKEN,
  );
  await waitForAssistantFinalText(client, MEMORY_RECALL_TOKEN, waitForFinalTimeoutMs);
  const finalText = await lastAssistantFinalText(client);
  const durableToolCalls = durableTranscriptToolCalls();
  assert(liveLlmCalls >= 1, `expected at least 1 real LLM call, observed ${liveLlmCalls}.`);
  assert(
    observedToolCalls.includes("recall_memory") || durableToolCalls.includes("recall_memory"),
    `live memory recall E2E did not call recall_memory: observed=${observedToolCalls.join(" -> ")} durable=${durableToolCalls.join(" -> ")}`,
  );
  assert(
    observedToolCalls.includes("query_memory") || durableToolCalls.includes("query_memory"),
    `live memory recall E2E did not call query_memory for exact chronology: observed=${observedToolCalls.join(" -> ")} durable=${durableToolCalls.join(" -> ")}`,
  );
  assert(
    !observedToolCalls.includes("run_command") && !durableToolCalls.includes("run_command"),
    `live memory recall E2E used run_command instead of query_memory: observed=${observedToolCalls.join(" -> ")} durable=${durableToolCalls.join(" -> ")}`,
  );
  assert(
    finalText.includes("recall_memory") && finalText.includes("query_memory"),
    "live memory recall final answer did not name both recall_memory and query_memory.",
  );
  assert(
    finalText.includes("2026-04-24") && finalText.includes(MEMORY_QUERY_FIRST_TEXT),
    "live memory recall final answer did not include the exact query_memory first-message evidence.",
  );
}

function readWatlWorkerEvidence(sinceMs = 0): Record<string, unknown> {
  const taskDirs = listTaskDirs(tempDir, sinceMs);
  const eventFiles = taskDirs.map((dir) => join(dir, "worker_activity_events.jsonl")).filter(existsSync);
  const projectionFiles = taskDirs.map((dir) => join(dir, "worker_activity.json")).filter(existsSync);
  const events = eventFiles.flatMap((file) => readJsonlObjects(file));
  const projections = projectionFiles.map((file) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  const phases = uniqueStrings(events.map((event) => stringField(event, "semantic_phase") || stringField(event, "semanticPhase")));
  const actions = uniqueStrings(events.map((event) => stringField(event, "action_kind") || stringField(event, "actionKind")));
  const completionObligations = uniqueStrings(events.flatMap((event) => stringArray(event.completion_obligations ?? event.completionObligations)));
  const evidenceRefs = uniqueStrings(events.flatMap((event) => stringArray(event.evidence_refs ?? event.evidenceRefs)));
  return { taskDirs, eventFiles, projectionFiles, eventCount: events.length, projectionCount: projections.length, phases, actions, completionObligations, evidenceRefs };
}

function listTaskDirs(butlerData: string, sinceMs = 0): string[] {
  const tasksRoot = join(butlerData, "tasks");
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot)
    .map((entry) => join(tasksRoot, entry))
    .filter((candidate) => {
      const stats = statSync(candidate);
      return stats.isDirectory() && stats.mtimeMs >= sinceMs;
    });
}

function readJsonlObjects(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split(/\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

async function waitForWatlWorkerOutcome(client: CdpClient, sinceMs: number): Promise<void> {
  const startedAt = Date.now();
  let evidence: Record<string, unknown> = {};
  let durableToolCalls: string[] = [];
  while (Date.now() - startedAt < 300_000) {
    evidence = readWatlWorkerEvidence(sinceMs);
    durableToolCalls = durableTranscriptToolCalls(latestE2eSessionId());
    const phases = stringArray(evidence.phases);
    const actions = stringArray(evidence.actions);
    if ((durableToolCalls.includes("dispatch_worker") || durableToolCalls.includes("create_planned_task") || durableToolCalls.includes("run_planned_task"))
      && Number(evidence.eventCount) > 0
      && phases.includes("executing")
      && phases.includes("verifying")
      && actions.some((action) => ["edit_file", "apply_patch", "write_file"].includes(action))) {
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  assert(durableToolCalls.includes("dispatch_worker") || durableToolCalls.includes("create_planned_task") || durableToolCalls.includes("run_planned_task"), `WATL worker Electron E2E did not start worker/planned work: ${durableToolCalls.join(" -> ")}`);
  const phases = stringArray(evidence.phases);
  const actions = stringArray(evidence.actions);
  assert(Number(evidence.eventCount) > 0, "WATL worker Electron E2E did not persist worker activity events.");
  assert(phases.includes("executing"), `WATL worker Electron E2E did not record executing semantic phase: ${phases.join(", ")}`);
  assert(phases.includes("verifying"), `WATL worker Electron E2E did not record verifying semantic phase: ${phases.join(", ")}`);
  assert(actions.some((action) => ["edit_file", "apply_patch", "write_file"].includes(action)), `WATL worker Electron E2E did not record implementation action evidence: ${actions.join(", ")}`);
}

async function runWatlWorkerBrowserScenario(client: CdpClient): Promise<void> {
  const scenarioStartedAt = Date.now() - 1_000;
  const prompt = [
    "WATL 문서에서 Electron 앱으로 worker timeline을 확인하는 절차가 아직 부족한 것 같아.",
    "이건 앱 실행 흐름까지 확인해야 해서 조금 길어질 수 있으니, 별도 작업으로 맡겨서 진행해줘.",
    "관련 문서만 짧게 보강하고, 수정 내용 확인과 검증까지 마친 뒤 결과를 알려줘.",
  ].join("\n");
  assert(!/테스트를 위해|WATL e2e|semantic phase|activity event|tool/iu.test(prompt), "WATL worker prompt must remain natural and must not name test internals.");
  await sendComposerTurn(client, prompt);
  await waitForWatlWorkerOutcome(client, scenarioStartedAt);
}

async function runBeegAutonomousBrowserScenario(client: CdpClient): Promise<void> {
  assert(
    !/recall_memory|query_memory|run_command|tool/iu.test(beegAutonomousPrompt),
    "BEEG autonomous prompt must not name tools.",
  );
  await sendComposerTurn(client, beegAutonomousPrompt);
  await waitForBeegAutonomousOutcome(client);
  const sessionId = latestE2eSessionId();
  const finalText = await lastAssistantFinalText(client);
  const durableToolCalls = durableTranscriptToolCalls(sessionId);
  const recallResults = durableTranscriptToolResultPayloads("recall_memory", sessionId);
  const recallDiagnostics = recallResults.flatMap((result) => stringArray(result.diagnostics));
  assert(liveLlmCalls >= 1, `expected at least 1 real LLM call, observed ${liveLlmCalls}.`);
  assert(
    observedToolCalls.includes("recall_memory"),
    `BEEG autonomous Electron E2E provider did not execute recall_memory in this run: observed=${observedToolCalls.join(" -> ")}`,
  );
  assert(
    durableToolCalls.includes("recall_memory"),
    `BEEG autonomous Electron E2E did not persist current-session recall_memory evidence: session=${sessionId} durable=${durableToolCalls.join(" -> ")}`,
  );
  assert(
    recallDiagnostics.includes("vector=ok"),
    `BEEG autonomous Electron E2E did not observe vector=ok diagnostics: ${recallDiagnostics.join(" | ")}`,
  );
  assert(
    recallDiagnostics.includes("ranking_policy=planned"),
    `BEEG autonomous Electron E2E did not observe planned ranking diagnostics: ${recallDiagnostics.join(" | ")}`,
  );
  assert(
    !durableToolCalls.includes("run_command"),
    `BEEG autonomous memory E2E fell back to run_command: ${durableToolCalls.join(" -> ")}`,
  );
  assert(
    finalText.length > 40 && !/^INCOMPLETE\s*:/iu.test(finalText.trim()),
    "BEEG autonomous final answer was missing or incomplete.",
  );
}

function readMemoryRecallEvidence(): Record<string, unknown> {
  const finalTokenRecovered = server.store.listMessages(latestE2eSessionId()).some((message) =>
    message.role === "assistant" && message.text.includes(MEMORY_RECALL_TOKEN));
  const durableCalls = durableTranscriptToolCalls();
  return {
    finalTokenRecovered,
    recallToolCalls: durableCalls.filter((name) => name === "recall_memory").length,
    queryToolCalls: durableCalls.filter((name) => name === "query_memory").length,
    runCommandToolCalls: durableCalls.filter((name) => name === "run_command").length,
    qualityKey: MEMORY_RECALL_TOKEN,
  };
}

function readBeegAutonomousEvidence(): Record<string, unknown> {
  const sessionId = latestE2eSessionId();
  const durableCalls = durableTranscriptToolCalls(sessionId);
  const recallResults = durableTranscriptToolResultPayloads("recall_memory", sessionId);
  return {
    sessionId,
    promptNamedTools: /recall_memory|query_memory|run_command|tool/iu.test(beegAutonomousPrompt),
    observedRecallToolCalls: observedToolCalls.filter((name) => name === "recall_memory").length,
    recallToolCalls: durableCalls.filter((name) => name === "recall_memory").length,
    runCommandToolCalls: durableCalls.filter((name) => name === "run_command").length,
    diagnostics: [...new Set(recallResults.flatMap((result) => stringArray(result.diagnostics)))],
    resultCount: recallResults.reduce((total, result) => {
      const results = Array.isArray(result.results) ? result.results : [];
      return total + results.length;
    }, 0),
    rawPrivateMemoryReported: false,
  };
}

async function runToolchainBrowserScenario(client: CdpClient): Promise<void> {
  if (usesForwardProgressScenario) {
    await runForwardProgressBrowserScenario(client);
    return;
  }
  await sendComposerTurn(client, toolchainPrompt);
  if (usesBtccOpeningDecisionScenario) {
    await waitForBtccOpeningDecisionVisible(client, BTCC_OPENING_DECISION_VISIBLE_THRESHOLD_MS);
  }
  if (e2eMode === "tool-profile") {
    await waitForAssistantFinalText(client, TOOLCHAIN_FINAL, waitForFinalTimeoutMs);
    const durableToolCalls = durableTranscriptToolCalls();
    for (const name of activeRequiredToolCalls) {
      assert(observedToolCalls.includes(name), `tool-profile E2E did not execute observed tool: ${name}`);
      assert(durableToolCalls.includes(name), `tool-profile E2E did not persist durable tool call: ${name}`);
    }
    assertRequiredToolchainOrder(observedToolCalls, "observed runtime tool calls");
    assertRequiredToolchainOrder(durableToolCalls, "durable transcript tool calls");
    assert(
      observedToolSurfaces.length === 1,
      `tool-profile E2E should use one provider-facing prompt, observed ${observedToolSurfaces.length}`,
    );
    assert(
      observedToolSurfaces[0]!.count < BUTLER_TOOLS.length,
      `tool-profile E2E provider surface was not smaller than global registry: ${JSON.stringify(observedToolSurfaces[0])}`,
    );
    assert(
      !observedToolSurfaces[0]!.names.some((name) => name.includes("weather")),
      `tool-profile E2E provider surface included weather tools: ${JSON.stringify(observedToolSurfaces[0])}`,
    );
    for (const name of ["run_command", "read_tool_output_artifact"]) {
      assert(
        observedToolSurfaces[0]!.names.includes(name),
        `tool-profile E2E full-access project turn did not expose workspace tool ${name}: ${
          JSON.stringify(observedToolSurfaces[0])
        }`,
      );
    }
    return;
  }
  if (usesWorkStreamScenario) {
    await waitForAnyVisible(
      client,
      [turnActivityPanelSelector, todoComposerPanelSelector],
      "workstream progress surface",
      waitForFinalTimeoutMs,
    );
    const activeScreenshotPath = join(screenshotDir, `${e2eMode}-workstream-progress.png`);
    await captureScreenshot(client, activeScreenshotPath);
    assert(statSync(activeScreenshotPath).size > 8_000, "workstream progress screenshot is unexpectedly small.");
  } else {
    await waitForAnyVisible(
      client,
      [turnWorkPanelSelector, turnWorkCollapsedSelector],
      "work surface",
      waitForFinalTimeoutMs,
    );
    await waitForActiveToolchainWorkBlock(client);
    const activeScreenshotPath = join(screenshotDir, `${e2eMode}-toolchain-active-work.png`);
    await captureScreenshot(client, activeScreenshotPath);
    assert(statSync(activeScreenshotPath).size > 8_000, "active work screenshot is unexpectedly small.");
  }
  if (usesDynamicDecisionContextScenario) {
    await waitForAssistantOutcomeReport(client);
  } else if (usesRealProjectCheckScenario) {
    await waitForRealProjectCheckOutcome(client);
  } else if (usesNaturalWorkStreamScenario) {
    await waitForNaturalWorkStreamOutcome(client);
  } else if (usesWorkStreamScenario) {
    await waitForAssistantFinalText(client, TOOLCHAIN_FINAL, waitForFinalTimeoutMs);
  } else if (usesArtifactReportScenario) {
    await waitForArtifactOutcomeReport(client);
  } else {
    await waitForAssistantFinalText(client, TOOLCHAIN_FINAL, waitForFinalTimeoutMs);
  }
  await waitForVisible(client, turnResultSectionSelector, "final result");
  if (!usesWorkStreamScenario) {
    await waitForVisible(client, turnWorkCollapsedSelector, "collapsed work");
    await assertCollapsedWorkPrecedesResult(client);
    await expandCollapsedTurnActivity(client);
    await waitForToolchainActivityContext(client);
    await collapseCollapsedTurnActivity(client);
    await assertCollapsedWorkPrecedesResult(client);
  }
  await assertFinalAnswerIsOutcomeOnly(client);
  if (usesDynamicDecisionContextScenario) {
    assert(
      csvReportFileWritten(),
      `decision-context toolchain did not create the expected CSV file at ${artifactReportCsvRelativePath}.`,
    );
    assert(
      durableCsvFileToolEvidenceVerified(),
      "decision-context toolchain did not produce durable write_file/read_file evidence for the expected CSV path and contents.",
    );
  } else if (usesWorkStreamScenario) {
    const runtimeToolCalls = readRuntimeToolCalls();
    assert(
      runtimeToolCalls.includes("update_todo_list") && runtimeToolCalls.includes("run_command"),
      "workstream toolchain did not create phase progress and execute a local validation command.",
    );
  } else if (usesArtifactReportScenario) {
    assert(
      artifactReportFilesWritten(),
      "artifact-report toolchain did not create both CSV and PNG files.",
    );
  } else if (usesDecisionContextScenario) {
    assert(
      publicDataArtifactWritten(),
      "decision-context toolchain did not write a public data CSV artifact.",
    );
  } else {
    assert(existsSync(toolchainDashboardPath), "toolchain did not write the isolated Project Ledger dashboard.");
    assert(
      readFileSync(toolchainDashboardPath, "utf8").includes("Project Ledger Dashboard"),
      "toolchain dashboard was written but did not contain the expected generated view.",
    );
  }
  const durableToolCalls = durableTranscriptToolCalls();
  const requiredObservedToolCalls = usesWorkStreamScenario
    ? durableToolCalls
    : [...observedToolCalls, ...durableToolCalls];
  for (const name of activeRequiredToolCalls) {
    assert(
      requiredObservedToolCalls.includes(name),
      [
        `single-prompt toolchain did not execute ${name}.`,
        `observed=${observedToolCalls.join(" -> ") || "(none)"}`,
        `durable=${durableToolCalls.join(" -> ") || "(none)"}`,
      ].join(" "),
    );
  }
  assertRequiredToolchainOrder(
    requiredObservedToolCalls,
    usesWorkStreamScenario
      ? "durable runtime tool calls"
      : "observed or durable runtime tool calls",
  );
  assertRequiredToolchainOrder(durableToolCalls, "durable transcript tool calls");
  if (e2eMode === "toolchain" || usesBtccOpeningDecisionScenario) {
    assert(
      prompts.length === 1,
      `deterministic toolchain should use one runtime prompt, observed ${prompts.length}: ${promptInvocationPreview()}`,
    );
    assert(
      observedToolCalls.length === requiredToolchainCalls.length,
      `deterministic toolchain should execute exactly ${requiredToolchainCalls.length} tools, observed ${observedToolCalls.length}.`,
    );
  }
  if (e2eMode === "decision-context") {
    assert(
      prompts.length === 1,
      `deterministic decision-context should use one runtime prompt, observed ${prompts.length}: ${promptInvocationPreview()}`,
    );
    assert(
      observedToolCalls.length === requiredDecisionContextCalls.length,
      `deterministic decision-context should execute exactly ${requiredDecisionContextCalls.length} tools, observed ${observedToolCalls.length}.`,
    );
  }
  const turnEvents = await replayAgentTurnEvents();
  const completedTools = usesExternalButlerService
    ? durableTranscriptToolResults()
    : turnEvents
        .filter((event) => event.kind === "tool.completed")
        .map((event) => String(event.payload?.toolName ?? ""));
  const minCompletedTools = usesWorkStreamScenario ? 1 : 3;
  assert(
    completedTools.length >= minCompletedTools,
    `expected at least ${minCompletedTools} completed tool events, observed ${completedTools.length}.`,
  );
  const workEvents = usesExternalButlerService || usesWorkStreamScenario
    ? durableTodoProgressLabels()
    : turnEvents
        .filter((event) => event.kind.startsWith("work.block."))
        .map((event) => String(event.payload?.workBlockId ?? ""));
  const minDynamicWorkLabels = usesDynamicDecisionContextScenario ? 2 : 1;
  const minWorkEvents = usesWorkStreamScenario
    ? 1
    : usesDynamicWorkLabels
      ? minDynamicWorkLabels
      : 6;
  assert(
    workEvents.length >= minWorkEvents,
    `expected at least ${minWorkEvents} work block events for toolchain, observed ${workEvents.length}.`,
  );
  const replayedLabels = turnEvents.map((event) =>
    String(event.payload?.safeLabel ?? event.payload?.label ?? event.payload?.note ?? ""),
  );
  if (usesExternalButlerService || usesWorkStreamScenario) {
    const durableProgressLabels = durableTodoProgressLabels();
    assert(
      durableProgressLabels.length >= 1,
      "WorkStream scenario did not deliver durable app progress updates.",
    );
  } else if (usesDynamicWorkLabels) {
    const replayedWorkLabels = turnEvents
      .filter((event) => event.kind === "work.block.started")
      .map((event) => String(event.payload?.safeLabel ?? event.payload?.decisionSummary ?? event.payload?.label ?? ""))
      .filter(Boolean);
    const minReplayWorkLabels = minDynamicWorkLabels;
    assert(
      replayedWorkLabels.length >= minReplayWorkLabels,
      `toolchain replay did not include enough live public work labels: ${replayedWorkLabels.join(" | ")}`,
    );
  } else {
    for (const label of [...activeWorkBlockLabels, ...activeProgressLabels]) {
      assert(
        replayedLabels.includes(label),
        `toolchain replay did not include contextual activity label: ${label}`,
      );
    }
  }
  if (usesDecisionContextScenario) {
    const decisionEvents = turnEvents.filter((event) =>
      event.kind === "work.block.started" &&
      typeof event.payload?.decisionSummary === "string" &&
      typeof event.payload.decisionRationale === "string",
    );
    const assistantDecisionEvents = decisionEvents.filter((event) =>
      event.payload?.decisionSource === "assistant-authored" ||
      event.payload?.decisionSource === "review-repaired",
    );
    const minDecisionEvents = usesDynamicDecisionContextScenario
      ? minDynamicWorkLabels
      : activeRequiredToolCalls.length;
    assert(
      decisionEvents.length >= minDecisionEvents,
      `expected at least ${minDecisionEvents} public decision work blocks, observed ${decisionEvents.length}.`,
    );
    if (usesDynamicDecisionContextScenario) {
      assert(
        assistantDecisionEvents.length >= 1,
        `expected at least 1 assistant-authored or repaired public decision; observed ${assistantDecisionEvents.length}.`,
      );
    } else {
      assert(
        assistantDecisionEvents.length >= 3,
        `expected at least 3 assistant-authored public decision work blocks, observed ${assistantDecisionEvents.length}.`,
      );
    }
  }
  if (usesLiveLlm && usesToolchainScenario && !usesExternalButlerService) {
    assert(liveLlmCalls >= 1, `expected at least 1 real LLM call, observed ${liveLlmCalls}.`);
  }
  if (usesBtccOpeningDecisionScenario) {
    await assertBtccOpeningDecisionTypedGate("final");
  }
}

async function runForwardProgressBrowserScenario(client: CdpClient): Promise<void> {
  await selectForwardProgressSession(client);
  forwardProgressTurnStartedAt = Date.now();
  await sendComposerTurn(client, toolchainPrompt);
  await waitForForwardProgressOpeningDecision();
  forwardProgressFirstMeaningfulMs = Date.now() - forwardProgressTurnStartedAt;
  await waitForAnyVisible(
    client,
    [turnWorkPanelSelector, turnWorkCollapsedSelector],
    "forward-progress work surface",
    waitForFinalTimeoutMs,
  );
  await waitForForwardProgressTerminal(client);
  await waitForVisible(client, turnResultSectionSelector, "forward-progress final result");
  await waitForVisible(client, turnWorkCollapsedSelector, "forward-progress collapsed work");
  await expandCollapsedTurnActivity(client);
  forwardProgressLiveBlocks = await visibleWorkBlockSnapshot(client);
  assert(forwardProgressLiveBlocks !== "[]", "forward-progress turn rendered no work blocks.");
  const finalText = await lastAssistantFinalText(client);
  assert(
    !/(?:turn_contract_decision_conflict|runtime finished without|fresh public work decision continuation needed)/iu.test(finalText),
    `forward-progress final exposed an internal failure: ${finalText}`,
  );
}

async function selectForwardProgressSession(client: CdpClient): Promise<void> {
  await waitForExpression(
    client,
    `(() => {
      const target = Array.from(document.querySelectorAll("button, a, [role='button']"))
        .find((element) => (element.textContent ?? "").includes(${JSON.stringify(forwardProgressSessionTitle)}));
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()`,
    "forward-progress project session",
    30_000,
  );
  await waitForVisible(client, composerTextareaSelector, "forward-progress composer");
}

async function waitForForwardProgressOpeningDecision(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitForFinalTimeoutMs) {
    const projection = await readBtccTypedProjection();
    if (projection.rows.some(isOpeningDecisionRow)) return;
    const sessionId = latestE2eSessionId();
    const response = await fetchJson(`${server.url}session-view?session_id=${encodeURIComponent(sessionId)}`);
    const state = (response.data as { latest_turn?: { state?: string } | null }).latest_turn?.state;
    if (state === "failed" || state === "cancelled") {
      throw new Error(`Forward-progress turn ended in ${state} before its opening decision.`);
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the forward-progress opening decision.");
}

async function waitForForwardProgressTerminal(client: CdpClient): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitForFinalTimeoutMs) {
    const sessionId = latestE2eSessionId();
    const response = await fetchJson(`${server.url}session-view?session_id=${encodeURIComponent(sessionId)}`);
    const data = response.data as {
      latest_turn?: { state?: string } | null;
    };
    const state = data.latest_turn?.state;
    if (state === "failed" || state === "cancelled") {
      throw new Error(`Forward-progress turn ended in ${state}.`);
    }
    if (state === "delivered" && (await lastAssistantFinalText(client)).trim()) return;
    await delay(250);
  }
  throw new Error("Timed out waiting for the forward-progress terminal result.");
}

async function visibleWorkBlockSnapshot(client: CdpClient): Promise<string> {
  return await evaluateString(client, `JSON.stringify(
    Array.from(document.querySelectorAll(${JSON.stringify(turnWorkCollapsedBlockSelector)})).map((block) => ({
      title: (block.querySelector(${JSON.stringify(turnWorkBlockHeaderSelector)})?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      text: (block.textContent ?? "").replace(/\\s+/g, " ").trim(),
      tools: Array.from(block.querySelectorAll(${JSON.stringify(turnWorkToolRowSelector)}))
        .map((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim()),
    }))
  )`);
}

async function finalizeForwardProgressBenchmark(
  liveReplayParity: boolean,
): Promise<ElectronForwardProgressBenchmark> {
  const sessionId = latestE2eSessionId();
  const events = await replayAgentTurnEvents();
  const toolCalls = durableTranscriptToolCalls(sessionId);
  const benchmark = collectElectronForwardProgressBenchmark({
    butlerData: tempDir,
    sinceTs: forwardProgressTurnStartedAt,
    completedAt: Date.now(),
    firstMeaningfulMs: forwardProgressFirstMeaningfulMs,
    toolCalls,
    openingDecisions: events.filter((event) =>
      event.kind === "assistant.decision" && event.payload?.role === "opening",
    ).length,
    noDeltaBroadReadRounds: noDeltaBroadReadRounds(sessionId),
    contractConflicts: durableTranscriptContains("turn_contract_decision_conflict") ? 1 : 0,
    genericInternalFailures: durableTranscriptContains("Runtime finished without a text result") ||
      durableTranscriptContains("Fresh public work decision continuation needed")
      ? 1
      : 0,
    liveReplayParity,
    ledgerBefore: forwardProgressLedgerBefore,
    ledgerRoot: forwardProgressLedgerRoot,
    toolCompletedAt: events
      .filter((event) => event.kind === "tool.completed")
      .map((event) => Date.parse(event.createdAt ?? ""))
      .filter(Number.isFinite),
  });
  assert(
    toolCalls.some((name) => PROJECT_LEDGER_MUTATION_TOOL_NAME_SET.has(name)),
    `forward-progress turn did not execute a Project Ledger mutation: ${toolCalls.join(" -> ")}`,
  );
  assert(
    toolCalls.some((name) => name === "project_ledger_check" || name === "project_ledger_status"),
    `forward-progress turn did not validate the isolated Ledger: ${toolCalls.join(" -> ")}`,
  );
  return benchmark;
}

function noDeltaBroadReadRounds(sessionId: string): number {
  const lastMutationBySignature = new Map<string, number>();
  let mutationRevision = 0;
  let repeats = 0;
  for (const call of durableTranscriptToolCallRecords(sessionId)) {
    if (PROJECT_LEDGER_MUTATION_TOOL_NAME_SET.has(call.name)) {
      mutationRevision += 1;
      continue;
    }
    if (!isBroadLedgerReadTool(call.name)) continue;
    const signature = `${call.name}:${JSON.stringify(call.args)}`;
    if (lastMutationBySignature.get(signature) === mutationRevision) repeats += 1;
    lastMutationBySignature.set(signature, mutationRevision);
  }
  return repeats;
}

function isBroadLedgerReadTool(name: string): boolean {
  return name === "inspect_project_status" ||
    name === "project_ledger_list" ||
    name === "project_ledger_status" ||
    name === "query_project_work";
}

function assertForwardProgressLedgerShape(changedRecords: string[]): void {
  assert(
    changedRecords.some((path) => path.startsWith("specs/")),
    `forward-progress turn did not create or update a spec: ${changedRecords.join(", ")}`,
  );
  assert(
    changedRecords.some((path) => /(^|\/)work\.md$/u.test(path)),
    `forward-progress turn did not create or update Work: ${changedRecords.join(", ")}`,
  );
  assert(
    changedRecords.some((path) => path.includes("/tasks/") && path.endsWith(".md")),
    `forward-progress turn did not create or update test tasks: ${changedRecords.join(", ")}`,
  );
  assert(
    JSON.stringify(snapshotTextFiles(forwardProgressWorkspace)) !==
      JSON.stringify(forwardProgressWorkspaceBefore),
    "forward-progress turn stopped after Ledger planning without continuing into the isolated workspace.",
  );
}

interface BtccProgressRow {
  id?: string;
  kind?: string;
  safe_label?: string;
  state?: string;
  created_at?: string;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  receipt_kind?: string;
  public_decision_role?: string;
  public_decision_summary?: string;
  public_decision_rationale?: string;
  public_decision_next_step?: string;
  public_decision_source?: string;
  public_decision_model_call_id?: string;
  public_decision_latency_ms?: number;
  work_block_id?: string;
  work_block_label?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  runtime_fault_id?: string;
  runtime_fault_kind?: string;
  runtime_fault_retryable?: boolean;
  runtime_fault_public_summary?: string;
  runtime_fault_safe_error_code?: string;
  safe_detail_rows?: Array<{ safe_label?: string; safe_value?: string; kind?: string }>;
}

type BtccTypedReadModel =
  | { type: "receipt"; row: BtccProgressRow }
  | { type: "decision"; row: BtccProgressRow }
  | { type: "work_block"; row: BtccProgressRow }
  | { type: "tool_control"; row: BtccProgressRow }
  | { type: "runtime_fault"; row: BtccProgressRow }
  | { type: "outcome"; row: BtccProgressRow }
  | { type: "observation"; row: BtccProgressRow };

async function waitForBtccOpeningDecisionVisible(client: CdpClient, thresholdMs?: number): Promise<void> {
  const startedAt = Date.now();
  let ackVisibleAt: number | undefined;
  let lastRowSummary = "";
  while (Date.now() - startedAt < waitForFinalTimeoutMs) {
    const projection = await readBtccTypedProjection();
    lastRowSummary = projection.rows
      .map((row) => `${row.kind ?? "unknown"}:${row.receipt_kind ?? row.public_decision_role ?? row.safe_label ?? ""}`)
      .join(" | ");
    if (projection.rows.some(isAcknowledgedReceiptRow)) {
      ackVisibleAt ??= Date.now();
    }
    const openingIndex = projection.rows.findIndex(isOpeningDecisionRow);
    if (openingIndex < 0) {
      const finalText = await visibleAssistantFinalText(client);
      assert(
        finalText.length === 0,
        `opening decision must precede assistant final text; observed ${JSON.stringify(finalText.slice(0, 240))}`,
      );
    }
    if (ackVisibleAt !== undefined && openingIndex < 0) {
      const prematureRows = projection.rows.filter(isPrematureBeforeOpeningRow);
      assert(
        prematureRows.length === 0,
        `opening decision must precede visible work, terminal state, or runtime fault; observed ${JSON.stringify(prematureRows)}`,
      );
      if (thresholdMs !== undefined && Date.now() - ackVisibleAt > thresholdMs + BTCC_OPENING_DECISION_WAIT_GRACE_MS) {
        throw new Error(
          `timed out waiting for typed opening decision after ACK; threshold=${thresholdMs}ms rows=${lastRowSummary}`,
        );
      }
    }
    if (ackVisibleAt !== undefined && projection.rows.some(isOpeningDecisionRow)) {
      const visibleLatencyMs = Date.now() - ackVisibleAt;
      btccOpeningDecisionGate = {
        ack_to_opening_decision_visible_ms: visibleLatencyMs,
        ...(thresholdMs === undefined ? {} : { threshold_ms: thresholdMs }),
        provider_opening_latency_ms: mockOpeningDecisionProviderLatencyMs,
        event_opening_latency_ms: projection.rows.find(isOpeningDecisionRow)?.public_decision_latency_ms,
      };
      if (thresholdMs !== undefined) {
        assert(
          visibleLatencyMs <= thresholdMs,
          `ack_to_opening_decision_visible_ms exceeded ${thresholdMs}: ${visibleLatencyMs}`,
        );
      }
      await assertBtccOpeningDecisionTypedGate("opening-visible");
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for typed opening decision; rows=${lastRowSummary}`);
}

function isPrematureBeforeOpeningRow(row: BtccProgressRow): boolean {
  return row.runtime_fault_id !== undefined ||
    row.kind === "work_block" ||
    isTypedToolControlRow(row) ||
    (row.kind === "turn" && ["delivered", "failed", "cancelled"].includes(row.state ?? ""));
}

async function visibleAssistantFinalText(client: CdpClient): Promise<string> {
  return await evaluateString(client, `(() => {
    const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
    return documents
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean)
      .join("\\n");
  })()`);
}

async function assertBtccOpeningDecisionTypedGate(phase: string): Promise<void> {
  const projection = await readBtccTypedProjection();
  const rows = projection.rows;
  const models = projection.models;
  const ackIndex = rows.findIndex(isAcknowledgedReceiptRow);
  const openingIndex = rows.findIndex(isOpeningDecisionRow);
  assert(ackIndex >= 0, `${phase}: typed projection is missing turn.acknowledged receipt.`);
  assert(openingIndex >= 0, `${phase}: typed projection is missing assistant.decision role=opening.`);
  assert(ackIndex < openingIndex, `${phase}: opening decision must follow turn.acknowledged.`);
  assert(
    mockOpeningDecisionProviderCalls === 1,
    `${phase}: mock provider should emit exactly one opening decision, observed ${mockOpeningDecisionProviderCalls}.`,
  );
  const ackRow = rows[ackIndex]!;
  assert(
    ackRow.kind === "turn" &&
      ackRow.state === "accepted" &&
      ackRow.receipt_kind === "turn.acknowledged" &&
      !ackRow.public_decision_role &&
      !ackRow.public_decision_source &&
      !ackRow.work_block_id &&
      !ackRow.tool_call_id,
    `${phase}: turn.acknowledged must remain a receipt/status row only: ${JSON.stringify(ackRow)}`,
  );
  const openingRow = rows[openingIndex]!;
  assert(
      openingRow.kind === "decision" &&
      openingRow.public_decision_role === "opening" &&
      openingRow.public_decision_source === "model-authored" &&
      typeof openingRow.public_decision_summary === "string" &&
      openingRow.public_decision_summary.trim().length > 0,
    `${phase}: opening decision row does not carry the expected typed model-authored projection: ${JSON.stringify(openingRow)}`,
  );
  if (usesDeterministicBtccOpeningDecisionScenario) {
    assert(
      openingRow.public_decision_summary === MOCK_OPENING_DECISION.summary &&
        openingRow.public_decision_model_call_id === "mock-opening-1",
      `${phase}: deterministic opening decision did not preserve the mock summary/modelCallId: ${JSON.stringify(openingRow)}`,
    );
  }
  assert(
    typeof openingRow.public_decision_latency_ms === "number" &&
      Number.isFinite(openingRow.public_decision_latency_ms) &&
      openingRow.public_decision_latency_ms >= 0,
    `${phase}: opening decision row must preserve typed latencyMs: ${JSON.stringify(openingRow)}`,
  );
  assert(
    !/^(Request received\. Preparing the work\.|Preparing to work on this\.|Working|Thinking)$/iu.test(
      openingRow.public_decision_summary,
    ),
    `${phase}: opening decision summary fell back to generic progress copy: ${JSON.stringify(openingRow)}`,
  );
  assertRowTimestampOrder(ackRow, openingRow, `${phase}: acknowledged/opening row order`);
  const preOpeningSemanticRows = rows
    .slice(ackIndex + 1, openingIndex)
    .filter((row) =>
      row.kind === "decision" ||
      row.kind === "work_block" ||
      isTypedToolControlRow(row) ||
      row.kind === "message" ||
      (row.kind === "turn" && !row.receipt_kind),
    );
  assert(
    preOpeningSemanticRows.length === 0,
    `${phase}: opening decision must be the first meaningful assistant event; observed earlier rows ${JSON.stringify(preOpeningSemanticRows)}`,
  );
  const workBlocks = models.filter((model) => model.type === "work_block");
  const toolControls = models.filter((model) => model.type === "tool_control");
  if (phase === "opening-visible") {
    assertNoBtccFallbackTypedState(rows, models, phase);
    assertNoGenericFirstProgressWorkBlock(workBlocks, phase);
    return;
  }
  assert(workBlocks.length >= 3, `${phase}: expected deterministic multi-tool work blocks, observed ${workBlocks.length}.`);
  assert(toolControls.length >= 3, `${phase}: expected deterministic multi-tool controls, observed ${toolControls.length}.`);
  assertTypedSurfaceOrder(models, phase);
  assertNoBtccFallbackTypedState(rows, models, phase);
  assertNoDuplicateBlockToolLabels(workBlocks, toolControls, phase);
  assertNoGenericFirstProgressWorkBlock(workBlocks, phase);
  assertTypedToolControlLabels(toolControls, phase);
}

async function readBtccTypedProjection(): Promise<{ rows: BtccProgressRow[]; models: BtccTypedReadModel[] }> {
  const sessionId = latestE2eSessionId();
  const [sessionView, eventRows] = await Promise.all([
    fetchJson(`${server.url}session-view?session_id=${encodeURIComponent(sessionId)}`),
    replayAgentProgressRows(),
  ]);
  const viewData = sessionView.data as {
    latest_turn?: {
      progress?: { safe_progress_rows?: BtccProgressRow[] };
    } | null;
  };
  const sessionRows = viewData.latest_turn?.progress?.safe_progress_rows ?? [];
  const rows = dedupeBtccProgressRows([...eventRows, ...sessionRows]);
  return {
    rows,
    models: rows.flatMap(projectBtccTypedReadModel),
  };
}

async function replayAgentProgressRows(): Promise<BtccProgressRow[]> {
  return (await replayTimelineEvents())
    .filter((event) => event.type === "agent.turn_event.progress" && event.payload?.row)
    .map((event) => event.payload!.row!);
}

function dedupeBtccProgressRows(rows: BtccProgressRow[]): BtccProgressRow[] {
  const seen = new Set<string>();
  const deduped: BtccProgressRow[] = [];
  for (const row of rows) {
    const key = [
      row.id,
      row.kind,
      row.receipt_kind,
      row.public_decision_role,
      row.tool_call_id,
      row.work_block_id,
      row.safe_label,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function projectBtccTypedReadModel(row: BtccProgressRow): BtccTypedReadModel[] {
  if (row.runtime_fault_id && row.runtime_fault_kind && row.runtime_fault_public_summary) {
    return [{ type: "runtime_fault", row }];
  }
  if (row.receipt_kind) return [{ type: "receipt", row }];
  if (row.kind === "decision" && row.public_decision_source && row.public_decision_summary) {
    return [{ type: "decision", row }];
  }
  if (row.kind === "work_block" && row.work_block_id) return [{ type: "work_block", row }];
  if (isTypedToolControlRow(row)) return [{ type: "tool_control", row }];
  if (row.kind === "turn" && ["delivered", "failed", "cancelled"].includes(row.state ?? "")) {
    return [{ type: "outcome", row }];
  }
  if (row.safe_detail_rows?.length) return [{ type: "observation", row }];
  return [];
}

function isAcknowledgedReceiptRow(row: BtccProgressRow): boolean {
  return row.receipt_kind === "turn.acknowledged";
}

function isOpeningDecisionRow(row: BtccProgressRow): boolean {
  return row.kind === "decision" &&
    row.public_decision_role === "opening" &&
    row.public_decision_source === "model-authored";
}

function isTypedToolControlRow(row: BtccProgressRow): boolean {
  return Boolean(row.tool_call_id && (row.safe_tool_name || row.safe_input_label));
}

function assertRowTimestampOrder(left: BtccProgressRow, right: BtccProgressRow, label: string): void {
  const leftMs = Date.parse(left.created_at ?? "");
  const rightMs = Date.parse(right.created_at ?? "");
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return;
  assert(leftMs <= rightMs, `${label}: ${left.created_at} should be <= ${right.created_at}`);
}

function assertTypedSurfaceOrder(models: BtccTypedReadModel[], phase: string): void {
  const receiptIndex = models.findIndex((model) => model.type === "receipt" && isAcknowledgedReceiptRow(model.row));
  const openingIndex = models.findIndex((model) => model.type === "decision" && isOpeningDecisionRow(model.row));
  const workIndex = models.findIndex((model) => model.type === "work_block");
  const toolIndex = models.findIndex((model) => model.type === "tool_control");
  assert(
    receiptIndex >= 0 && openingIndex > receiptIndex,
    `${phase}: typed readmodels must start with receipt before opening decision.`,
  );
  assert(
    workIndex > openingIndex,
    `${phase}: work blocks must not appear before the opening decision.`,
  );
  assert(
    toolIndex > workIndex,
    `${phase}: tool controls must appear after their work block surface.`,
  );
}

function assertNoBtccFallbackTypedState(
  rows: BtccProgressRow[],
  models: BtccTypedReadModel[],
  phase: string,
): void {
  const forbiddenStates = new Set([
    "recovering_internal",
    "needs_evidence",
    "completion_continuation",
    "runtime_continuation",
  ]);
  const badStateRows = rows.filter((row) => forbiddenStates.has(row.state ?? ""));
  assert(badStateRows.length === 0, `${phase}: public projection exposed forbidden turn states: ${JSON.stringify(badStateRows)}`);
  const runtimeFaults = models.filter((model) => model.type === "runtime_fault");
  assert(runtimeFaults.length === 0, `${phase}: deterministic gate exposed public runtime fault/retry state: ${JSON.stringify(runtimeFaults)}`);
  const fallbackPatterns = [
    /recover(?:y|ing)|recovering_internal/iu,
    /model[- ]?budget|token budget|maxOutputTokens/iu,
    /verification failure|completion verification|could not verify/iu,
    /needs_evidence/iu,
    /\bretry\b/iu,
  ];
  const badPublicFields = rows
    .filter((row) => !isAcknowledgedReceiptRow(row))
    .flatMap((row) => typedPublicTextFields(row).map((value) => ({ row, value })))
    .filter(({ value }) => fallbackPatterns.some((pattern) => pattern.test(value)));
  assert(
    badPublicFields.length === 0,
    `${phase}: public typed fields exposed recovery/model-budget/verification fallback text: ${JSON.stringify(badPublicFields)}`,
  );
}

function typedPublicTextFields(row: BtccProgressRow): string[] {
  return [
    row.safe_label,
    row.public_decision_summary,
    row.public_decision_rationale,
    row.public_decision_next_step,
    row.work_block_label,
    row.work_decision_summary,
    row.work_decision_rationale,
    row.work_decision_next_step,
    row.runtime_fault_public_summary,
    ...(row.safe_detail_rows ?? []).flatMap((detail) => [detail.safe_label, detail.safe_value]),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function assertNoDuplicateBlockToolLabels(
  workBlocks: Array<Extract<BtccTypedReadModel, { type: "work_block" }>>,
  toolControls: Array<Extract<BtccTypedReadModel, { type: "tool_control" }>>,
  phase: string,
): void {
  for (const block of workBlocks) {
    const blockLabel = (block.row.work_block_label ?? "").trim();
    if (!blockLabel) continue;
    const duplicateTools = toolControls.filter((tool) =>
      tool.row.work_block_id === block.row.work_block_id &&
      typedToolControlLabel(tool.row) === blockLabel,
    );
    assert(
      duplicateTools.length === 0,
      `${phase}: work block label was duplicated into tool controls: ${blockLabel}`,
    );
  }
}

function typedToolControlLabel(row: BtccProgressRow): string {
  const toolName = row.safe_tool_name ?? "";
  const inputLabel = row.safe_input_label ?? "";
  return toolName && inputLabel ? `${toolName}: ${inputLabel}` : toolName || inputLabel;
}

function assertTypedToolControlLabels(
  toolControls: Array<Extract<BtccTypedReadModel, { type: "tool_control" }>>,
  phase: string,
): void {
  const labels = toolControls.map((model) => typedToolControlLabel(model.row)).filter(Boolean);
  for (const label of labels) {
    assert(
      !requiredToolchainCalls.some((name) => label.includes(name)),
      `${phase}: typed tool control exposed raw tool id in user-facing label: ${label}`,
    );
  }
  let cursor = 0;
  for (const label of labels) {
    if (label === expectedToolchainToolControlLabels[cursor]) cursor += 1;
    if (cursor === expectedToolchainToolControlLabels.length) return;
  }
  throw new Error(
    `${phase}: expected user-facing tool control order not observed: ${labels.join(" -> ")}`,
  );
}

function assertNoGenericFirstProgressWorkBlock(
  workBlocks: Array<Extract<BtccTypedReadModel, { type: "work_block" }>>,
  phase: string,
): void {
  const genericBlocks = workBlocks.filter((block) =>
    block.row.work_block_id?.startsWith("first-progress-") ||
    /^(Request received\. Preparing the work\.|Preparing to work on this\.|Working|Thinking)$/iu.test(
      (block.row.work_block_label ?? block.row.safe_label ?? "").trim(),
    ),
  );
  assert(
    genericBlocks.length === 0,
    `${phase}: generic first-progress row leaked as a standalone work block: ${JSON.stringify(genericBlocks)}`,
  );
}

async function assertCanonicalSessionSnapshot(
  client: CdpClient,
  phase: string,
): Promise<void> {
  let lastError: unknown;
  const attempts = usesLiveLlm ? 20 : 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await assertCanonicalSessionSnapshotOnce(client, phase);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function assertCanonicalSessionSnapshotOnce(
  client: CdpClient,
  phase: string,
): Promise<void> {
  const sessionId = latestE2eSessionId();
  const [sessionView, messages, summary] = await Promise.all([
    fetchJson(`${server.url}session-view?session_id=${encodeURIComponent(sessionId)}`),
    fetchJson(`${server.url}messages?chat_id=${encodeURIComponent(sessionId)}&cursor=0`),
    fetchJson(`${server.url}session-summary?session_id=${encodeURIComponent(sessionId)}`),
  ]);
  const viewData = sessionView.data as {
    status?: string;
    active_turn?: unknown;
    latest_turn?: {
      id?: string;
      state?: string;
      progress?: { safe_progress_rows?: Array<{ state?: string }> };
    } | null;
    messages?: Array<{
      id?: string;
      role?: string;
      text?: string;
      work_blocks?: unknown[];
    }>;
  };
  const messageData = messages.data as {
    messages?: Array<{ id?: string; role?: string; text?: string }>;
  };
  const summaryData = summary.data as {
    turn_state?: string;
    latest_progress?: { state?: string; safe_progress_rows?: Array<{ state?: string }> };
  };
  const viewMessages = viewData.messages ?? [];
  const replayMessages = messageData.messages ?? [];
  assert(viewMessages.length > 0, `${phase}: canonical session view has no messages.`);
  assert(
    new Set(viewMessages.map((message) => message.id)).size === viewMessages.length,
    `${phase}: canonical session view contains duplicate message ids.`,
  );
  assert(
    replayMessages.map((message) => message.id).join("\n") ===
      viewMessages.map((message) => message.id).join("\n"),
    `${phase}: /messages replay differs from /session-view.`,
  );
  const latestState = viewData.latest_turn?.state ?? "idle";
  assert(
    summaryData.turn_state === latestState,
    `${phase}: /session-summary turn state ${summaryData.turn_state} differs from /session-view ${latestState}.`,
  );
  if (["delivered", "failed", "cancelled"].includes(latestState)) {
    assert(
      viewData.active_turn === null,
      `${phase}: terminal session still exposes an active turn.`,
    );
    const runningRows = [
      ...(viewData.latest_turn?.progress?.safe_progress_rows ?? []),
      ...(summaryData.latest_progress?.safe_progress_rows ?? []),
    ].filter((row) => row.state === "running");
    assert(
      runningRows.length === 0,
      `${phase}: terminal session still exposes running progress rows.`,
    );
  }
  const visibleFinal = (await lastAssistantFinalText(client))
    .replace(/\s+/g, " ")
    .trim();
  const latestAssistant = [...viewMessages]
    .reverse()
    .find((message) => message.role === "assistant");
  const latestAssistantText = normalizeMarkdownForRenderedText(latestAssistant?.text ?? "");
  const latestAssistantComparable = comparableRenderedText(latestAssistantText);
  const visibleFinalComparable = comparableRenderedText(visibleFinal);
  assert(
    latestAssistantComparable &&
      visibleFinalComparable.includes(
        latestAssistantComparable.slice(
          0,
          Math.min(80, latestAssistantComparable.length),
        ),
      ),
    `${phase}: visible final text is not backed by the canonical session view. ` +
      `canonical=${JSON.stringify(latestAssistantText.slice(0, 160))} ` +
      `visible=${JSON.stringify(normalizeMarkdownForRenderedText(visibleFinal).slice(0, 160))}`,
  );
  if (usesToolchainScenario) {
    const hasDurableWork =
      Boolean(viewData.latest_turn?.progress?.safe_progress_rows?.length) ||
      viewMessages.some((message) => message.role === "assistant" && (message.work_blocks?.length ?? 0) > 0);
    assert(hasDurableWork, `${phase}: toolchain session has no durable work evidence.`);
  }
}

function normalizeMarkdownForRenderedText(value: string): string {
  return value
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/^\s*```[^\n]*$/gmu, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gmu, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gmu, "")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*]\s+/gmu, "")
    .replace(/\|/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function comparableRenderedText(value: string): string {
  return normalizeMarkdownForRenderedText(value).replace(/\s+/gu, "");
}

function latestE2eSessionId(): string {
  const sessions = server.store.listSessions({
    kind: usesForwardProgressScenario ? "project" : "chat",
  }).sessions;
  const forwardProgressSession = usesForwardProgressScenario
    ? sessions.find((session) => session.title === forwardProgressSessionTitle)
    : undefined;
  const candidate = forwardProgressSession ?? sessions.find((session) => session.last_message_preview) ??
    sessions[0];
  assert(candidate?.id, "could not find the active E2E chat session.");
  return candidate.id;
}

async function reloadElectronPageAndAssertStable(client: CdpClient): Promise<void> {
  const before = (await lastAssistantFinalText(client)).replace(/\s+/g, " ").trim();
  assert(before.length > 0, "cannot reload-verify an empty final answer.");
  await client.send("Page.reload", { ignoreCache: true });
  await waitForExpression(
    client,
    "document.body && document.body.innerText.length > 0",
    "app shell after reload",
    30_000,
  );
  await waitForExpression(
    client,
    `(() => {
      const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
      const hasFinal = documents.some((element) =>
        (element.textContent ?? "").replace(/\\s+/g, " ").trim().includes(${JSON.stringify(before.slice(0, 80))})
      );
      if (hasFinal) return true;

      const chatRow = document.querySelector(".chat-row[role='button']");
      if (chatRow instanceof HTMLElement) {
        chatRow.click();
        return false;
      }
      const needles = [
        "Local private Butler workspace E2E toolchain",
        "Butler decision-context E2E medium data task",
        "Butler WorkStream FSM live E2E check",
        "지금 브랜치가 뭔지",
        "공개 웹에서 접근 가능한 자료",
        "메모리 엔진 도구 이름",
        "web.capture",
        "Forward Progress Benchmark",
      ];
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
      const target = candidates.find((element) => {
        const text = (element.textContent ?? "").replace(/\\s+/g, " ").trim();
        return needles.some((needle) => text.includes(needle));
      });
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return false;
    })()`,
    "final answer after Electron reload",
    30_000,
  );
  if (usesToolchainScenario) {
    await waitForVisible(client, turnWorkCollapsedSelector, "collapsed work after reload");
  }
}

async function waitForActiveToolchainWorkBlock(client: CdpClient): Promise<void> {
  const visibleWorkBlockSelector = `${turnWorkPanelBlockSelector}, ${turnWorkCollapsedBlockSelector}`;
  if (usesDynamicWorkLabels) {
    await waitForExpression(
      client,
      `Array.from(document.querySelectorAll(${JSON.stringify(visibleWorkBlockSelector)})).some((block) => {
        const header = block.querySelector(${JSON.stringify(turnWorkBlockHeaderSelector)});
        const headerText = (header?.textContent ?? "").replace(/\\s+/g, " ").trim();
        const headerIsButton = header instanceof HTMLButtonElement || Boolean(header?.querySelector("button"));
        const toolRows = Array.from(block.querySelectorAll(${JSON.stringify(turnWorkToolRowSelector)}));
        return headerText.length > 8 &&
          !headerIsButton &&
          toolRows.length > 0 &&
          toolRows.every((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim() !== headerText);
      })`,
      "active dynamic work block with nested toolchain",
      waitForFinalTimeoutMs,
    );
    return;
  }
  await waitForExpression(
    client,
    `Array.from(document.querySelectorAll(${JSON.stringify(visibleWorkBlockSelector)})).some((block) => {
      const header = block.querySelector(${JSON.stringify(turnWorkBlockHeaderSelector)});
      const headerText = (header?.textContent ?? "").replace(/\\s+/g, " ").trim();
      const headerIsButton = header instanceof HTMLButtonElement || Boolean(header?.querySelector("button"));
      const toolRows = Array.from(block.querySelectorAll(${JSON.stringify(turnWorkToolRowSelector)}));
      const text = block.textContent ?? "";
      return text.includes(${JSON.stringify(activeWorkBlockLabels[0])}) &&
        headerText.includes(${JSON.stringify(activeWorkBlockLabels[0])}) &&
        !headerIsButton &&
        toolRows.length > 0 &&
        toolRows.every((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim() !== headerText);
    })`,
    "active work block with nested toolchain",
    waitForFinalTimeoutMs,
  );
}

async function waitForToolchainActivityContext(client: CdpClient): Promise<void> {
  if (usesDynamicWorkLabels) {
    const minimumExpandedBlocks = usesWorkStreamScenario ? 1 : 2;
    await waitForExpression(
      client,
      `(() => {
        const trigger = document.querySelector(${JSON.stringify(turnWorkCollapsedTriggerSelector)});
        return trigger?.getAttribute("aria-expanded") === "true" &&
          document.querySelectorAll(${JSON.stringify(turnWorkCollapsedBlockSelector)}).length >= ${minimumExpandedBlocks};
      })()`,
      "expanded live work blocks",
      waitForFinalTimeoutMs,
    );
    const blockDataJson = await evaluateString(
      client,
      `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(turnWorkCollapsedBlockSelector)})).map((block) => ({
        label: (block.querySelector(${JSON.stringify(turnWorkBlockHeaderSelector)})?.textContent ?? "").replace(/\\s+/g, " ").trim(),
        headerIsButton: block.querySelector(${JSON.stringify(turnWorkBlockHeaderSelector)}) instanceof HTMLButtonElement || Boolean(block.querySelector(${JSON.stringify(`${turnWorkBlockHeaderSelector} button`)})),
        tools: Array.from(block.querySelectorAll(${JSON.stringify(turnWorkToolRowSelector)})).map((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim()),
      })))`,
    );
    const blockData = JSON.parse(blockDataJson) as Array<{ label: string; headerIsButton: boolean; tools: string[] }>;
    assert(
      blockData.length >= minimumExpandedBlocks,
      `expanded live work should contain at least ${minimumExpandedBlocks} blocks, observed: ${blockDataJson}`,
    );
    for (const block of blockData) {
      assert(block.label.length > 8, `expanded live work block has an empty or generic label: ${blockDataJson}`);
      assert(!block.headerIsButton, `expanded live work block rendered the public objective as a disclosure row: ${blockDataJson}`);
      if (!usesWorkStreamScenario) {
        assert(block.tools.length > 0, `expanded live work block has no nested toolchain row: ${blockDataJson}`);
      }
      assert(
        block.tools.every((tool) => tool !== block.label),
        `expanded live work block duplicated its public objective as a toolchain row: ${blockDataJson}`,
      );
    }
    const triggerText = await evaluateString(
      client,
      `(document.querySelector(${JSON.stringify(turnWorkCollapsedTriggerSelector)})?.textContent ?? "").replace(/\\s+/g, " ").trim()`,
    );
    if (usesWorkStreamScenario && blockData.length === 1) {
      assert(
        triggerText === blockData[0]?.label,
        `collapsed live work trigger should use the single public work summary, observed: ${triggerText}`,
      );
    } else {
      const expectedTriggerText =
        blockData.length <= 1
          ? blockData[0]?.label
          : `${blockData[0]?.label} 외 ${blockData.length - 1}개 진행 내역`;
      assert(
        triggerText === expectedTriggerText,
        `collapsed live work trigger should use the public work summary, observed: ${triggerText}, expected: ${expectedTriggerText}`,
      );
    }
    return;
  }
  for (const label of activeWorkBlockLabels) {
    await waitForExpression(
      client,
      `Array.from(document.querySelectorAll(${JSON.stringify(turnWorkCollapsedHeaderSelector)})).some((element) => element.textContent?.includes(${JSON.stringify(label)}))`,
      `activity context label ${label}`,
      waitForFinalTimeoutMs,
    );
  }
  const expectedTriggerText = `${activeWorkBlockLabels[0]} 외 ${activeWorkBlockLabels.length - 1}개 진행 내역`;
  await waitForExpression(
    client,
    `(document.querySelector(${JSON.stringify(turnWorkCollapsedTriggerSelector)})?.textContent ?? "").replace(/\\s+/g, " ").trim() === ${JSON.stringify(expectedTriggerText)}`,
    "collapsed public work summary trigger",
    waitForFinalTimeoutMs,
  );
  const triggerText = await evaluateString(
    client,
    `(document.querySelector(${JSON.stringify(turnWorkCollapsedTriggerSelector)})?.textContent ?? "").replace(/\\s+/g, " ").trim()`,
  );
  assert(
    triggerText === expectedTriggerText,
    `collapsed work trigger should use the public work summary, observed: ${triggerText}`,
  );
  assert(
    !triggerText.includes("작업") && !triggerText.includes("결과"),
    `collapsed work trigger should not use generic section labels, observed: ${triggerText}`,
  );
  const blockDataJson = await evaluateString(
    client,
    `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(turnWorkCollapsedBlockSelector)})).map((block) => ({
      label: (block.querySelector(${JSON.stringify(turnWorkBlockHeaderSelector)})?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      headerIsButton: block.querySelector(${JSON.stringify(turnWorkBlockHeaderSelector)}) instanceof HTMLButtonElement || Boolean(block.querySelector(${JSON.stringify(`${turnWorkBlockHeaderSelector} button`)})),
      tools: Array.from(block.querySelectorAll(${JSON.stringify(turnWorkToolRowSelector)})).map((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim()),
    })))`,
  );
  const blockData = JSON.parse(blockDataJson) as Array<{ label: string; headerIsButton: boolean; tools: string[] }>;
  assert(
    blockData.length === activeWorkBlockLabels.length,
    `expanded work should contain one block per toolchain step, observed: ${blockDataJson}`,
  );
  for (const label of activeWorkBlockLabels) {
    const block = blockData.find((item) => item.label === label);
    assert(
      block && block.tools.length > 0,
      `expanded work block did not contain nested toolchain rows for ${label}; observed: ${blockDataJson}`,
    );
    assert(
      block && !block.headerIsButton,
      `expanded work block rendered the public objective as a toolchain disclosure row for ${label}; observed: ${blockDataJson}`,
    );
    assert(
      block && block.tools.every((tool) => tool !== label),
      `expanded work block duplicated its public objective as a toolchain row for ${label}; observed: ${blockDataJson}`,
    );
  }
  const collapsedActivityText = await evaluateString(
    client,
    `(document.querySelector(${JSON.stringify(turnWorkCollapsedSelector)})?.textContent ?? "").replace(/\\s+/g, " ").trim()`,
  );
  const promptEchoes = usesDecisionContextScenario
    ? [
      "Collect a small, easy public data sample",
      "Transform the collected rows",
      "Then write a concise outcome report",
    ]
    : [
      "Inspect local Project Ledger status",
      "Query local Project Ledger work",
      "Render the local Project Ledger dashboard",
    ];
  for (const promptEcho of promptEchoes) {
    assert(
      !collapsedActivityText.includes(promptEcho),
      `collapsed activity appears to echo prompt instructions instead of projected turn events: ${promptEcho}`,
    );
  }
  for (const forbidden of [
    "Reading Checking local Project Ledger status",
    "Using web search: Reviewing Project Ledger next actions",
    "Editing: Rendering Project Ledger dashboard view",
  ]) {
    assert(
      !triggerText.includes(forbidden) &&
        !blockData.some((item) => item.label.includes(forbidden) || item.tools.some((tool) => tool.includes(forbidden))),
      `activity context exposed an implementation prefix instead of work context: ${forbidden}`,
    );
  }
}

async function expandCollapsedTurnActivity(client: CdpClient): Promise<void> {
  await evaluateBoolean(client, `(() => {
    const button = document.querySelector(${JSON.stringify(turnWorkCollapsedTriggerSelector)});
    if (!(button instanceof HTMLElement)) return false;
    if (button.getAttribute("aria-expanded") !== "true") button.click();
    return true;
  })()`);
}

async function collapseCollapsedTurnActivity(client: CdpClient): Promise<void> {
  await evaluateBoolean(client, `(() => {
    const button = document.querySelector(${JSON.stringify(turnWorkCollapsedTriggerSelector)});
    if (!(button instanceof HTMLElement)) return false;
    if (button.getAttribute("aria-expanded") === "true") button.click();
    button.scrollIntoView({ block: "center", inline: "nearest" });
    return button.getAttribute("aria-expanded") === "false";
  })()`);
}

async function assertCollapsedWorkPrecedesResult(client: CdpClient): Promise<void> {
  const ordered = await evaluateBoolean(client, `(() => {
    const articles = Array.from(document.querySelectorAll(${JSON.stringify(`${assistantMessageSelector}:not(${turnActivityMessageSelector})`)}));
    const article = articles.at(-1);
    if (!article) return false;
    const work = article.querySelector(${JSON.stringify(turnWorkCollapsedSelector)});
    const result = article.querySelector(${JSON.stringify(turnResultSectionSelector)});
    if (!work || !result) return false;
    return Boolean(work.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING);
  })()`);
  assert(ordered, "collapsed work should render before the final result section, not below it.");
}

async function assertFinalAnswerIsOutcomeOnly(client: CdpClient): Promise<void> {
  const finalText = await lastAssistantFinalText(client);
  if (usesDynamicDecisionContextScenario) {
    assert(finalText.length > 120, "live final assistant answer was too short to be an outcome report.");
    assert(!/^INCOMPLETE\s*:/iu.test(finalText.trim()), "live final assistant answer reported an incomplete goal.");
    assert(
      /(?:서울|Seoul|부산|Busan|인구|population)/iu.test(finalText),
      "live final assistant answer did not mention the collected population data.",
    );
  } else if (usesArtifactReportScenario) {
    assert(finalText.length > 120, "live artifact final assistant answer was too short to be an outcome report.");
    assert(!/^INCOMPLETE\s*:/iu.test(finalText.trim()), "live artifact final assistant answer reported an incomplete goal.");
    assert(
      /(?:서울|Seoul|부산|Busan|인구|population|CSV|PNG|그래프|chart)/iu.test(finalText),
      "live artifact final assistant answer did not mention the created data or chart outcome.",
    );
  } else if (usesRealProjectCheckScenario) {
    assert(finalText.length > 40, "real project check final assistant answer was too short to be an outcome report.");
    assert(!/^INCOMPLETE\s*:/iu.test(finalText.trim()), "real project check final assistant answer reported an incomplete goal.");
    assert(
      /(?:브랜치|branch)/iu.test(finalText) &&
        /(?:커밋|commit|작업트리|status|변경|change)/iu.test(finalText) &&
        /(?:리스크|risk|주의|조심|없음|none)/iu.test(finalText),
      "real project check final assistant answer did not summarize branch, changes, and risk.",
    );
  } else if (usesNaturalWorkStreamScenario) {
    assert(finalText.length > 40, "natural WorkStream final assistant answer was too short to be an outcome report.");
    assert(!/^INCOMPLETE\s*:/iu.test(finalText.trim()), "natural WorkStream final assistant answer reported an incomplete goal.");
    assert(
      /(?:WorkStream|workstream|워크스트림)/iu.test(finalText) &&
        /(?:main|branch|브랜치)/iu.test(finalText) &&
        /(?:app:client:workstream:live-llm:e2e|live-llm-workstream|등록되어 있지|not registered|No WorkStream script)/iu.test(finalText),
      "natural WorkStream final assistant answer did not mention the checked script and branch outcome.",
    );
  } else {
    assert(finalText.includes(TOOLCHAIN_FINAL), "final assistant answer did not contain the validation token.");
  }
  for (const forbidden of [
    "Toolchain calls:",
    "Dashboard written:",
    "Evidence basis:",
    "inspect_project_status",
    "query_project_work",
    "render_project_dashboard",
    "web_search",
    "web_read",
    "write_file",
    "read_file",
    "transform_public_data_table",
    "run_command",
    "Checking local Project Ledger status",
    "Reviewing Project Ledger next actions",
    "Rendering Project Ledger dashboard view",
    "Transforming public data table",
    "Project Ledger: status",
    "Project Ledger: next actions",
    "Project Ledger: dashboard view",
    "Delivered",
  ]) {
    assert(
      !finalText.includes(forbidden),
      `final assistant answer exposed toolchain implementation detail: ${forbidden}`,
    );
  }
}

function assertRequiredToolchainOrder(calls: string[], label: string): void {
  let cursor = 0;
  for (const call of calls) {
    if (call === activeRequiredToolCalls[cursor]) cursor += 1;
    if (cursor === activeRequiredToolCalls.length) return;
  }
  throw new Error(`required toolchain order not observed in ${label}: ${calls.join(" -> ")}`);
}

interface CdpClient {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

async function sendComposerTurn(client: CdpClient, text: string): Promise<void> {
  await evaluateBoolean(client, `(() => {
    const element = document.querySelector(${JSON.stringify(composerTextareaSelector)});
    if (!(element instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, ${JSON.stringify(text)});
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: ${JSON.stringify(text)},
      inputType: "insertText",
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === ${JSON.stringify(text)};
  })()`);
  await waitForExpression(client, `(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(composerSendButtonSelector)})).at(-1);
    return Boolean(button && !button.disabled);
  })()`, "send button enabled");
  await evaluateBoolean(client, `(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(composerSendButtonSelector)})).at(-1);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
}

async function captureScreenshot(client: CdpClient, path: string): Promise<void> {
  await client.send("Page.enable");
  const result = await client.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  writeFileSync(path, Buffer.from(result.data, "base64"));
}

async function waitForVisible(client: CdpClient, selector: string, label: string): Promise<void> {
  await waitForExpression(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  })()`, `${label} visible`);
}

async function waitForAnyVisible(
  client: CdpClient,
  selectors: string[],
  label: string,
  timeoutMs?: number,
): Promise<void> {
  await waitForExpression(client, `(() => {
    return ${JSON.stringify(selectors)}.some((selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  })()`, `${label} visible`, timeoutMs);
}

async function waitForVisibleOrAssistantFinalText(
  client: CdpClient,
  selector: string,
  label: string,
  finalText: string,
): Promise<void> {
  await waitForExpression(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element) {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden") return true;
    }
    return ${assistantFinalTextIncludesExpression(finalText)};
  })()`, `${label} visible or final text rendered`, waitForFinalTimeoutMs);
}

async function waitForComposerModel(client: CdpClient, modelRef: string): Promise<void> {
  const modelId = modelRef.replace(/^local\//u, "");
  const requiredParts = modelId
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length >= 3)
    .slice(0, 3);
  await waitForExpression(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(composerModelButtonSelector)});
      const text = (element?.textContent ?? "").toLocaleLowerCase();
      return ${JSON.stringify(requiredParts)}.every((part) => text.includes(part));
    })()`,
    `composer model ${modelRef}`,
    30_000,
  );
}

async function assertNoVisibleStatusOnlyFinalActivity(client: CdpClient): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  const visible = await evaluateBoolean(client, `(() => {
    const element = document.querySelector(${JSON.stringify(turnActivityCollapsedSelector)});
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  })()`);
  assert(!visible, "status-only final activity should stay hidden for a no-tool multiturn exchange.");
}

function liveDiagnostics(message: string): string {
  if (!usesLiveLlm) return message;
  return [
    message,
    `mode=${e2eMode}`,
    `liveLlmCalls=${liveLlmCalls}`,
    `firstPromptObserved=${Boolean(prompts[0])}`,
    `secondPromptObserved=${Boolean(prompts[1])}`,
    `secondPromptContainsFirstFinal=${Boolean(prompts[1]?.includes(FIRST_FINAL))}`,
  ].join("; ");
}

async function assistantFinalTextIncludes(client: CdpClient, text: string): Promise<boolean> {
  return await evaluateBoolean(client, assistantFinalTextIncludesExpression(text));
}

async function waitForAssistantFinalText(client: CdpClient, text: string, timeoutMs?: number): Promise<void> {
  await waitForExpression(
    client,
    assistantFinalTextIncludesExpression(text),
    `assistant final text ${text}`,
    timeoutMs,
  );
}

async function waitForAssistantOutcomeReport(client: CdpClient): Promise<void> {
  await waitForExpression(
    client,
    `(() => {
      const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
      const text = (documents.at(-1)?.textContent ?? "").replace(/\\s+/g, " ").trim();
      return text.length > 120 &&
        !/^INCOMPLETE\\s*:/i.test(text) &&
        /(?:서울|Seoul|부산|Busan|인구|population)/i.test(text);
    })()`,
    "assistant outcome report",
    waitForFinalTimeoutMs,
  );
}

async function waitForArtifactOutcomeReport(client: CdpClient): Promise<void> {
  await waitForExpression(
    client,
    `(() => {
      const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
      const text = (documents.at(-1)?.textContent ?? "").replace(/\\s+/g, " ").trim();
      return text.length > 120 &&
        !/^INCOMPLETE\\s*:/i.test(text) &&
        /(?:서울|Seoul|부산|Busan|인구|population|CSV|PNG|그래프|chart)/i.test(text);
    })()`,
    "assistant artifact outcome report",
    waitForFinalTimeoutMs,
  );
}

async function waitForNaturalWorkStreamOutcome(client: CdpClient): Promise<void> {
  await waitForExpression(
    client,
    `(() => {
      const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
      const text = (documents.at(-1)?.textContent ?? "").replace(/\\s+/g, " ").trim();
      return text.length > 40 &&
        !/^INCOMPLETE\\s*:/i.test(text) &&
        /(?:WorkStream|workstream|워크스트림)/i.test(text) &&
        /(?:main|branch|브랜치)/i.test(text) &&
        /(?:app:client:workstream:live-llm:e2e|live-llm-workstream|등록되어 있지|not registered|No WorkStream script)/i.test(text);
    })()`,
    "natural WorkStream outcome report",
    waitForFinalTimeoutMs,
  );
}

async function waitForRealProjectCheckOutcome(client: CdpClient): Promise<void> {
  await waitForExpression(
    client,
    `(() => {
      const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
      const text = (documents.at(-1)?.textContent ?? "").replace(/\\s+/g, " ").trim();
      return text.length > 40 &&
        !/^INCOMPLETE\\s*:/i.test(text) &&
        /(?:브랜치|branch)/i.test(text) &&
        /(?:커밋|commit|작업트리|status|변경|change)/i.test(text) &&
        /(?:리스크|risk|주의|조심|없음|none)/i.test(text);
    })()`,
    "real project check outcome report",
    waitForFinalTimeoutMs,
  );
}

async function waitForBeegAutonomousOutcome(client: CdpClient): Promise<void> {
  await waitForExpression(
    client,
    `(() => {
      const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
      const text = (documents.at(-1)?.textContent ?? "").replace(/\\s+/g, " ").trim();
      return text.length > 40 && !/^INCOMPLETE\\s*:/i.test(text);
    })()`,
    "BEEG autonomous memory outcome",
    waitForFinalTimeoutMs,
  );
}

async function waitForAnyAssistantFinalText(client: CdpClient, texts: string[], timeoutMs?: number): Promise<void> {
  await waitForExpression(
    client,
    texts.map(assistantFinalTextIncludesExpression).join(" || "),
    `any assistant final text: ${texts.join(", ")}`,
    timeoutMs,
  );
}

function assistantFinalTextIncludesExpression(text: string): string {
  return `Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)})).some((element) => element.textContent?.includes(${JSON.stringify(text)}))`;
}

async function waitForExpression(client: CdpClient, expression: string, label: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluateBoolean(client, expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function evaluateBoolean(client: CdpClient, expression: string): Promise<boolean> {
  const result = await client.send<{
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) return false;
  return result.result?.value === true;
}

async function evaluateString(client: CdpClient, expression: string): Promise<string> {
  const result = await client.send<{
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) return "";
  return typeof result.result?.value === "string" ? result.result.value : "";
}

async function lastAssistantFinalText(client: CdpClient): Promise<string> {
  return await evaluateString(client, `(() => {
    const documents = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
    const element = documents.at(-1);
    return element?.textContent ?? "";
  })()`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function connectToElectronPage(port: number, appUrl: string): Promise<CdpClient> {
  const origin = new URL(appUrl).origin;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    if (electronProcess?.exitCode !== null || electronProcess?.signalCode !== null) {
      throw new Error(
        `Electron exited before CDP target appeared: code=${electronProcess?.exitCode ?? "none"} signal=${electronProcess?.signalCode ?? "none"}`,
      );
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json()) as CdpTarget[];
      const target = targets.find((item) =>
        item.type === "page" &&
        item.url?.startsWith(origin) &&
        item.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) {
        const client = await connectCdp(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        return client;
      }
    } catch {
      // Retry while Electron starts and exposes the renderer target.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Timed out waiting for Electron page target at ${origin}.`);
}

async function completeFirstRunSetupForE2e(client: CdpClient): Promise<void> {
  const stateJson = JSON.stringify({
    schema: "butler.app.first-run.v1",
    status: "complete",
    language: "ko",
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "ready",
    connection_mode: "bundled-agent",
    completed_at: "2026-06-15T00:00:00.000Z",
  });
  const seedFirstRunStateExpression =
    `localStorage.setItem(${JSON.stringify(FIRST_RUN_STORAGE_KEY)}, ${JSON.stringify(stateJson)});`;
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: seedFirstRunStateExpression,
  });
  await client.send("Runtime.evaluate", {
    expression: `${seedFirstRunStateExpression} true`,
    returnByValue: true,
  });
  await client.send("Runtime.evaluate", {
    expression: "location.reload(); true",
    returnByValue: true,
  });
  await waitForExpression(
    client,
    `localStorage.getItem(${JSON.stringify(FIRST_RUN_STORAGE_KEY)}) === ${JSON.stringify(stateJson)}`,
    "first-run setup completion state seeded",
  );
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error(`Timed out opening CDP socket: ${url}`)), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error(`Failed to open CDP socket: ${url}`));
    }, { once: true });
  });
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!payload.id) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    if (payload.error) entry.reject(new Error(payload.error.message ?? "CDP command failed."));
    else entry.resolve(payload.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) entry.reject(new Error("CDP socket closed."));
    pending.clear();
  });

  return {
    send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId;
      nextId += 1;
      const command = { id, method, params };
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        socket.send(JSON.stringify(command));
      });
    },
    close() {
      socket.close();
      for (const entry of pending.values()) entry.reject(new Error("CDP socket closed."));
      pending.clear();
    },
  };
}

function stopElectron(): void {
  if (!electronProcess || electronProcess.exitCode !== null) return;
  electronProcess.kill("SIGTERM");
  const child = electronProcess;
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function durableTranscriptContains(text: string): boolean {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return false;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    if (readFileSync(join(dir, file), "utf8").includes(text)) return true;
  }
  return false;
}

function durableTranscriptToolCalls(sessionId?: string): string[] {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          sessionId?: unknown;
          kind?: string;
          payload?: { name?: unknown };
        };
        if (
          durableTranscriptEventMatchesSession(event, sessionId) &&
          event.kind === "tool_call" &&
          typeof event.payload?.name === "string"
        ) {
          names.push(event.payload.name);
        }
      } catch {
        // Ignore malformed transcript lines; the E2E assertions use the valid durable events.
      }
    }
  }
  return names;
}

function durableTranscriptToolCallRecords(
  sessionId?: string,
): Array<{ name: string; args: Record<string, unknown> }> {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          sessionId?: unknown;
          kind?: string;
          payload?: { name?: unknown; arguments?: unknown };
        };
        const name = typeof event.payload?.name === "string" ? event.payload.name : "";
        if (
          durableTranscriptEventMatchesSession(event, sessionId) &&
          event.kind === "tool_call" &&
          name
        ) {
          calls.push({
            name,
            args: projectedToolArguments(event.payload?.arguments) ?? {},
          });
        }
      } catch {
        // Ignore malformed transcript lines; valid events remain ordered.
      }
    }
  }
  return calls;
}

function durableTranscriptToolCallArguments(toolName: string, sessionId?: string): Array<Record<string, unknown>> {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return [];
  const calls: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          sessionId?: unknown;
          kind?: string;
          payload?: { name?: unknown; arguments?: unknown };
        };
        if (
          durableTranscriptEventMatchesSession(event, sessionId) &&
          event.kind === "tool_call" &&
          event.payload?.name === toolName &&
          event.payload.arguments &&
          typeof event.payload.arguments === "object" &&
          !Array.isArray(event.payload.arguments)
        ) {
          const projected = projectedToolArguments(event.payload.arguments);
          if (projected) calls.push(projected);
        }
      } catch {
        // Ignore malformed transcript lines; the E2E assertions use valid durable events.
      }
    }
  }
  return calls;
}

function projectedToolArguments(value: unknown): Record<string, unknown> | null {
  const record = objectRecord(value);
  if (record?.schema_version !== TOOL_CALL_ARGUMENTS_TRANSCRIPT_SCHEMA) {
    return null;
  }
  const safeArguments = objectRecord(record?.safe_arguments);
  return safeArguments;
}

function durableTranscriptEventMatchesSession(event: { sessionId?: unknown }, sessionId?: string): boolean {
  if (!sessionId) return true;
  const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  if (eventSessionId === sessionId) return true;
  return !sessionId.startsWith("butler/") && eventSessionId === `butler/app-${sessionId}`;
}

function durableTranscriptToolResults(): string[] {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          kind?: string;
          payload?: { name?: unknown; ok?: unknown };
        };
        if (
          event.kind === "tool_result" &&
          event.payload?.ok === true &&
          typeof event.payload.name === "string"
        ) {
          names.push(event.payload.name);
        }
      } catch {
        // Ignore malformed transcript lines; the E2E assertions use valid durable events.
      }
    }
  }
  return names;
}

function durableTranscriptToolResultPayloads(toolName: string, sessionId?: string): Array<Record<string, unknown>> {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return [];
  const results: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          sessionId?: unknown;
          kind?: string;
          payload?: { name?: unknown; ok?: unknown; result?: unknown };
        };
        if (
          durableTranscriptEventMatchesSession(event, sessionId) &&
          event.kind === "tool_result" &&
          event.payload?.ok === true &&
          event.payload.name === toolName &&
          event.payload.result &&
          typeof event.payload.result === "object" &&
          !Array.isArray(event.payload.result)
        ) {
          results.push(event.payload.result as Record<string, unknown>);
        }
      } catch {
        // Ignore malformed transcript lines; the E2E assertions use valid durable events.
      }
    }
  }
  return results;
}

function durableTranscriptEvidenceToolResultPayloads(
  toolName: string,
  sessionId?: string,
): Array<Record<string, unknown>> {
  return durableTranscriptToolResultPayloads(toolName, sessionId)
    .filter(isEvidenceTranscriptToolResultProjection);
}

function isEvidenceTranscriptToolResultProjection(
  result: Record<string, unknown>,
): boolean {
  if (result.schema_version !== TOOL_RESULT_EVIDENCE_TRANSCRIPT_SCHEMA) {
    return false;
  }
  if (
    RAW_TOOL_RESULT_TRANSCRIPT_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(result, field),
    )
  ) {
    return false;
  }
  return (
    Array.isArray(result.evidence_capability_receipts) &&
    Array.isArray(result.evidence_receipts) &&
    Boolean(objectRecord(result.completion_obligation_evidence))
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function durableTodoProgressLabels(): string[] {
  const storeLabels = durableStoreTodoProgressLabels();
  if (storeLabels.length > 0) return storeLabels;

  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return [];
  const labels: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          kind?: string;
          transport?: string;
          payload?: {
            metadata?: {
              kind?: unknown;
              safeLabel?: unknown;
              state?: unknown;
            };
          };
        };
        const metadata = event.payload?.metadata;
        if (
          event.kind === "outbound" &&
          event.transport === "app" &&
          metadata?.kind === "todo_progress" &&
          typeof metadata.safeLabel === "string"
        ) {
          labels.push(`${metadata.safeLabel}:${String(metadata.state ?? "")}`);
        }
      } catch {
        // Ignore malformed transcript lines; the E2E assertions use valid durable events.
      }
    }
  }
  return labels;
}

function durableStoreTodoProgressLabels(): string[] {
  try {
    const sessionId = latestE2eSessionId();
    const view = server.store.getSessionView(sessionId);
    const rows = (view.latest_turn?.progress?.safe_progress_rows ?? []) as Array<{
      safe_label?: unknown;
      state?: unknown;
    }>;
    return rows
      .filter((row) => typeof row.safe_label === "string" && row.safe_label.trim())
      .map((row) => `${String(row.safe_label)}:${String(row.state ?? "")}`);
  } catch {
    return [];
  }
}

function durableAppOutboundExists(): boolean {
  const dir = join(tempDir, "transcripts");
  if (!existsSync(dir)) return false;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          kind?: string;
          transport?: string;
          payload?: {
            message?: { text?: unknown };
          };
        };
        if (
          event.kind === "outbound" &&
          event.transport === "app" &&
          typeof event.payload?.message?.text === "string" &&
          event.payload.message.text.trim().length > 0
        ) {
          return true;
        }
      } catch {
        // Ignore malformed transcript lines; valid durable outbound evidence is asserted above.
      }
    }
  }
  return false;
}

function publicDataArtifactWritten(): boolean {
  const dir = join(tempDir, "artifacts", "public-data");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((file) =>
    file.endsWith(".csv") &&
    (e2eMode !== "decision-context" ||
      readFileSync(join(dir, file), "utf8").includes("중앙탑 야외 음악회")),
  );
}

function artifactReportFilesWritten(): boolean {
  const files = listFilesRecursive(artifactReportDir);
  const csv = files.find((file) => file.endsWith(".csv"));
  const png = files.find((file) => file.endsWith(".png"));
  return Boolean(
    csv &&
      png &&
      statSync(csv).size > 32 &&
      statSync(png).size > 8_000,
  );
}

function csvReportFileWritten(): boolean {
  return (
    existsSync(artifactReportCsvPath) &&
    statSync(artifactReportCsvPath).isFile() &&
    csvContentHasRequiredCityPopulationRows(
      readFileSync(artifactReportCsvPath, "utf8"),
    )
  );
}

function durableCsvFileToolEvidenceVerified(): boolean {
  const writeCalls = durableTranscriptToolCallArguments("write_file");
  const readCalls = durableTranscriptToolCallArguments("read_file");
  const writeResults = durableTranscriptEvidenceToolResultPayloads("write_file");
  const readResults = durableTranscriptEvidenceToolResultPayloads("read_file");
  const matchesExpectedPath = (value: unknown) =>
    normalizeRelativePath(value) === normalizeRelativePath(artifactReportCsvRelativePath);
  const hasWriteCall = writeCalls.some((call) => matchesExpectedPath(call.path));
  const hasReadCall = readCalls.some((call) => matchesExpectedPath(call.path));
  const hasWriteResult = writeResults.some((result) =>
    evidenceResultHasReceipt(result, {
      capability: "durable_artifact",
      satisfies: "durable_artifact",
      pathMatches: matchesExpectedPath,
    }),
  );
  const hasReadResult = readResults.some((result) =>
    evidenceResultHasReceipt(result, {
      capability: "source_verified",
      satisfies: "source_verified",
      pathMatches: matchesExpectedPath,
    }),
  );
  return hasWriteCall && hasReadCall && hasWriteResult && hasReadResult;
}

function evidenceResultHasReceipt(
  result: Record<string, unknown>,
  options: {
    capability: string;
    satisfies: string;
    pathMatches: (value: unknown) => boolean;
  },
): boolean {
  return (
    evidenceCapabilityReceipts(result).some((receipt) =>
      receipt.capability === options.capability &&
      receipt.verified === true &&
      evidenceReceiptHasReferencePath(receipt, options.pathMatches),
    ) ||
    legacyEvidenceReceipts(result).some((receipt) =>
      stringArray(receipt.satisfies).includes(options.satisfies) &&
      receipt.verified === true &&
      evidenceReceiptHasReferencePath(receipt, options.pathMatches),
    )
  );
}

function evidenceCapabilityReceipts(result: Record<string, unknown>): Array<Record<string, unknown>> {
  return recordArray(result.evidence_capability_receipts);
}

function legacyEvidenceReceipts(result: Record<string, unknown>): Array<Record<string, unknown>> {
  return recordArray(result.evidence_receipts);
}

function evidenceReceiptHasReferencePath(
  receipt: Record<string, unknown>,
  pathMatches: (value: unknown) => boolean,
): boolean {
  return recordArray(receipt.references).some((reference) =>
    pathMatches(reference.path ?? reference.ref),
  );
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(objectRecord(item)))
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeRelativePath(value: unknown): string {
  return typeof value === "string" ? value.replace(/\\/gu, "/").replace(/^\.\//u, "") : "";
}

function csvContentHasRequiredCityPopulationRows(content: string): boolean {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 4) return false;
  const headers = lines[0]!
    .split(",")
    .map((header) => header.trim().toLocaleLowerCase("en-US"));
  const cityIndex = headers.indexOf("city");
  const populationIndex = headers.indexOf("population");
  if (cityIndex < 0 || populationIndex < 0) return false;
  const dataRows = lines.slice(1).filter((line) => {
    const columns = line.split(",").map((column) => column.trim());
    const city = columns[cityIndex] ?? "";
    const population = columns[populationIndex] ?? "";
    return city.length > 0 && /\d/u.test(population);
  });
  return dataRows.length >= 3;
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return [dir];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...listFilesRecursive(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

function snapshotTextFiles(rootPath: string): Record<string, string> {
  return Object.fromEntries(
    listFilesRecursive(rootPath)
      .filter((path) => statSync(path).isFile())
      .map((path) => [
        relative(rootPath, path).replaceAll("\\", "/"),
        readFileSync(path, "utf8"),
      ]),
  );
}

function promptInvocationPreview(): string {
  return prompts
    .map((prompt, index) => {
      const lines = prompt.split("\n").map((line) => line.trim()).filter(Boolean);
      const marker = lines.find((line) => line.includes("Freshness evidence required")) ??
        lines.find((line) => line.includes("Repair") || line.includes("Runtime Evidence Policy")) ??
        lines[0] ??
        "";
      return `${index + 1}:${marker.slice(0, 120)}`;
    })
    .join(" | ");
}

async function replayAgentTurnEventKinds(): Promise<string[]> {
  return (await replayAgentTurnEvents()).map((event) => event.kind);
}

async function replayDecisionSourceCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const event of await replayAgentTurnEvents()) {
    if (event.kind !== "work.block.started") continue;
    const source = typeof event.payload?.decisionSource === "string"
      ? event.payload.decisionSource
      : "unknown";
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

async function replayAgentTurnEvents(): Promise<Array<{
  kind: string;
  visibility?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}>> {
  return (await replayTimelineEvents())
    .filter((event) => event.type === "agent.turn_event")
    .map((event) => event.payload?.event)
    .filter((event): event is {
      kind: string;
      visibility?: string;
      createdAt?: string;
      payload?: Record<string, unknown>;
    } =>
      Boolean(event?.kind && event.visibility !== "internal"),
    );
}

type ReplayTimelineEvent = {
  id?: number;
  type?: string;
  payload?: {
    row?: BtccProgressRow;
    event?: {
      kind?: string;
      visibility?: string;
      createdAt?: string;
      payload?: Record<string, unknown>;
    };
  };
};

async function replayTimelineEvents(): Promise<ReplayTimelineEvent[]> {
  const events: ReplayTimelineEvent[] = [];
  let cursor = 0;
  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(`${server.url}events?cursor=${cursor}`);
    assert(response.ok, `event replay failed with HTTP ${response.status}`);
    const body = await response.json() as {
      data?: {
        events?: ReplayTimelineEvent[];
        next_cursor?: number;
      };
    };
    const pageEvents = body.data?.events ?? [];
    events.push(...pageEvents);
    const nextCursor = body.data?.next_cursor;
    if (!pageEvents.length || typeof nextCursor !== "number" || nextCursor <= cursor) {
      return events;
    }
    cursor = nextCursor;
  }
  throw new Error("event replay pagination exceeded 20 pages.");
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  assert(response.ok, `GET ${url} failed with HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}
