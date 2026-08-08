import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const SANDY_CORRECTION_VERSION = 2;
export const SANDY_RECIPE_VERSION = "sandy-turn-work-recipe-2026-08-08.v2";
export const SANDY_CANONICAL_DB_PATH = join(homedir(), ".butler", "app-server", "butler-client.sqlite");
export const SANDY_SESSION_ID = "butler/app-project-bdc1ab45-3cff-401f-9b2e-98a991aa234d";
export const SANDY_SOURCE_WORK_ID = "guided-work-9e114e913e87156179c750e745add710efaf2f636a28a2216615d5dbf5446145";
export const SANDY_MONITORING_TURN_IDS = [
  "turn-e03778e9-2cd6-4d04-b062-2b8202284d23",
  "turn-5390e98a-2a08-4d77-b075-27921725c585",
] as const;
export const SANDY_CAPTURE_TURN_IDS = [
  "turn-a784a700-8d7b-42b8-80ae-e31f193601d3",
  "turn-e6b9910c-ff0a-4e84-8630-e0bcbf86c859",
] as const;
export const SANDY_EXPECTED_RESULT_COUNTS = {
  [SANDY_MONITORING_TURN_IDS[0]]: 65,
  [SANDY_MONITORING_TURN_IDS[1]]: 63,
  [SANDY_CAPTURE_TURN_IDS[0]]: 63,
  [SANDY_CAPTURE_TURN_IDS[1]]: 118,
} as const;
export const SANDY_SOURCE_SCOPE_KIND = "project";
export const SANDY_SOURCE_SCOPE_REF = "project-sandy-bot-35a0e102";
export const SANDY_SOURCE_OBJECTIVE = "샌디의 관계 점수 회복과 정책 판정-응답 행동 불일치를 수정하고, 운영 배포 후 수정 전후 지표를 비교해 효과와 부작용을 검증한다.";
export const SANDY_SOURCE_PLAN_REVISION_ID = "guided-plan-e69cd114943a7ee36c8f450aa054191bad64aa422e2f4b510fd6db018aba3211";
export const SANDY_SOURCE_PLAN_REVISION = 1;
export const SANDY_SOURCE_PLAN_CHECKS = [
  "단순 질답·무의미 대화는 친밀도와 신뢰도를 올리지 않는다.",
  "JSON 출력 강제와 역할·소리 흉내 강요가 정책상 조작으로 판정되면 실제 답변에서 그대로 수행되지 않는다.",
  "거의 정상인 JSON 문법 오류는 의미 보존 가능한 경우만 복구하며, 복구 불가 시 점수 변화 없는 fallback을 사용한다.",
  "전용 회귀 테스트와 전체 정적 검사·테스트가 통과한다.",
  "배포 전후 동일한 지표 정의로 운영 결과를 비교하고 표본 수와 관찰 한계를 함께 보고한다.",
] as const;
export const SANDY_SOURCE_CURRENT_RESULT_SEQUENCE = 65;
export const SANDY_SELECTED_TOOL_JOURNAL_COUNT = 317;
export const SANDY_SOURCE_CURRENT_ACTION_STATUSES = ["done", "done", "done", "active"] as const;
export const SANDY_CAPTURE_OBJECTIVE = "샌디 이미지 캡처 기능을 잠시 내려줘. 왜 다시 살아났어? 프록시나 외부 브라우저 기능을 이용하기 전에는 사용하지 못하게 해줘";
export const SANDY_KNOWN_COMMIT = "a83f3e3";
export const SANDY_SOURCE_ACTION_KEYS = [
  "현재 구현과 운영 기준선 확정",
  "관계 정책과 행동 강제 패치",
  "검증 후 운영 배포",
  "수정 전후 모니터링 비교",
] as const;

export type SandyCorrectionTarget = {
  dbPath: string;
  sessionId: string;
  sourceWorkId: string;
  monitoringTurnIds: readonly [string, string];
  captureTurnIds: readonly [string, string];
};

export type SandyCorrectionExpectation = {
  sourceStatus: "open";
  bindingCount: number;
  resultCount: number;
  bindingDigest: string;
  resultDigest: string;
  sourceIdentitySha256: string;
  beforeSnapshotSha256: string;
};

export type SandyCorrectionDisposition = {
  summary: string;
  actionUpdates: readonly SandyActionUpdate[];
  remainingActions: readonly string[];
  nextCondition: string | null;
  evidenceRefs: readonly string[];
  evidenceSnapshot: unknown;
  followups: readonly string[];
};

export type SandyActionUpdate = {
  actionKey: string;
  status: "done" | "skipped" | "blocked" | "active";
  note?: string;
};

export type SandyCorrectionInput = SandyCorrectionTarget & {
  expected: SandyCorrectionExpectation;
  disposition: SandyCorrectionDisposition;
  capturePlan?: SandyCapturePlan;
  captureCheckpoint?: SandyCaptureCheckpoint;
  operatorReason: string;
  operatorId?: string;
  apply?: boolean;
  ownerStopped?: boolean;
  ownerStopManifestPath?: string;
  ownerStopManifestSha256?: string;
  backupDir?: string;
  now?: string;
};

export type SandyCapturePlanAction = {
  actionKey: string;
  description: string;
  dependencyKeys: string[];
  status: "pending" | "active" | "done" | "blocked" | "skipped";
  note?: string;
};

export type SandyCapturePlan = {
  objective: string;
  governingRefs: readonly string[];
  actions: readonly SandyCapturePlanAction[];
  checks: readonly string[];
};

export type SandyCaptureCheckpoint = {
  stage: "conception" | "planning" | "execution" | "review" | "validation" | "reporting";
  publicSummary: string;
  nextStep: string;
  actionProgress: readonly SandyActionUpdate[];
  resultSequence: number;
  originTurnId: string;
};

export function defaultCapturePlan(): SandyCapturePlan {
  return {
    objective: "Disable browser capture until the external browser/proxy gate is available, then harden selector and unsafe-screen filtering.",
    governingRefs: ["commit:a83f3e3", "turn:e6-final-excluded-as-fallback"],
    actions: [
      {
        actionKey: "disable-capture-without-proxy",
        description: "Keep browser capture disabled unless the proxy or external-browser capability is explicitly available; commit a83f3e3 has tests/push/deploy evidence.",
        dependencyKeys: [],
        status: "done",
        note: "Observed committed and deployed in Sandy checkout at a83f3e3; no new completion claim is inferred.",
      },
      {
        actionKey: "harden-capture-screen-safety",
        description: "Filter selector captures that are challenge, blank, or IP-exposing screens and verify the current uncommitted diff/tests before any deployment.",
        dependencyKeys: ["disable-capture-without-proxy"],
        status: "active",
        note: "Current Sandy diff/tests are uncommitted; deployment is not claimed.",
      },
    ],
    checks: [
      "Capture stays unavailable without proxy or external-browser capability.",
      "Safety tests cover challenge, blank, and IP-exposing screens before deployment.",
    ],
  };
}

export function defaultCaptureCheckpoint(originTurnId: string, resultSequence = 181): SandyCaptureCheckpoint {
  return {
    stage: "execution",
    publicSummary: "The capture gate patch is committed/deployed; follow-up screen-safety hardening remains uncommitted and incomplete. The follow-up assistant final is excluded as contaminated fallback evidence.",
    nextStep: "Finish and verify the screen-safety hardening before claiming a follow-up deployment.",
    actionProgress: [
      { actionKey: "disable-capture-without-proxy", status: "done" },
      { actionKey: "harden-capture-screen-safety", status: "active", note: "Current Sandy diff/tests are uncommitted; no commit or deployment is claimed." },
    ],
    resultSequence,
    originTurnId,
  };
}

export function defaultMonitoringDisposition(
  monitoringTurnIds: readonly [string, string],
): SandyCorrectionDisposition {
  return {
    summary: "Monitoring evidence was retained and the Work was closed from the audited gate.",
    actionUpdates: SANDY_SOURCE_ACTION_KEYS.map((actionKey) => ({
      actionKey,
      status: "done" as const,
      note: actionKey === "수정 전후 모니터링 비교"
        ? "57-sample monitoring gate is complete; nonblocking followups remain observational."
        : "Audited source Plan evidence records this action as complete.",
    })),
    remainingActions: [],
    nextCondition: null,
    evidenceRefs: [...monitoringTurnIds],
    evidenceSnapshot: {
      source: "operator_audit",
      monitoringTurnIds: [...monitoringTurnIds],
      judgeSamples: 57,
      observationHours: 16.5,
      modelFailures: 0,
      trustDelta: 0,
      intimacyChange: "small_nonblocking_rise",
      retrievalFailures: "followup_only",
    },
    followups: [
      "Recheck the nonblocking intimacy trend in a later monitoring sample.",
      "Review observed retrieval failures as a separate follow-up.",
    ],
  };
}

export type SandyFileIdentity = {
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  sha256?: string;
};

export type SandyDatabaseIdentity = {
  canonicalPath: string;
  size: number;
  mtimeMs: number;
  pageCount: number;
  pageSize: number;
  schemaVersion: number;
  userVersion: number;
  journalMode: string;
  wal: SandyFileIdentity;
  shm: SandyFileIdentity;
  sha256: string;
};

export type SandyBindingRow = {
  bindingRevisionId: string;
  turnId: string;
  sessionId: string;
  workId: string;
  revision: number;
  isCurrent: number;
  boundAt: string;
};

export type SandyResultRow = {
  resultRef: string;
  workId: string;
  sequence: number;
  toolCallId: string;
  originTurnId: string;
  attachedAt: string;
  toolStatus?: string | null;
  toolResultSha256?: string | null;
};

export type SandyWorkRow = {
  workId: string;
  sessionId: string;
  scopeKind: string;
  scopeRef: string;
  originTurnId: string;
  originMessageId: string;
  objective: string;
  status: string;
  currentPlanRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SandyPlanSnapshot = {
  planRevisionId: string;
  revision: number;
  objective: string;
  actions: Array<{ actionKey: string; dependencyKeys: string[]; description: string }>;
  checks: string[];
  originTurnId: string;
};

export type SandyCheckpointSnapshot = {
  checkpointRevisionId: string;
  revision: number;
  planRevisionId: string;
  stage: string;
  publicSummary: string;
  nextStep: string;
  actionStates: Array<{ actionKey: string; status: string; note?: string }>;
  resultSequence: number;
  originTurnId: string;
};

export type SandyTurnMessage = {
  turnId: string;
  originalMessageId: string;
  originalMessage: string;
};

export type SandyCorrectionRead = {
  target: SandyCorrectionTarget;
  identity: SandyDatabaseIdentity;
  sourceWork: SandyWorkRow;
  sourcePlan: SandyPlanSnapshot | null;
  sourceCheckpoint: SandyCheckpointSnapshot | null;
  sessionHeadWorkId: string | null;
  bindings: SandyBindingRow[];
  results: SandyResultRow[];
  turnMessages: SandyTurnMessage[];
  sourceResultCount: number;
  sourceBindingCount: number;
  monitoringResultCount: number;
  captureResultCount: number;
  resultCountByTurn: Record<string, number>;
  selectedToolJournalCount: number;
  selectedToolJournalDigest: string;
  bindingDigest: string;
  resultDigest: string;
  beforeSnapshot: SandyBeforeSnapshot;
  beforeSnapshotSha256: string;
};

export type SandyBeforeSnapshot = {
  sourceWork: SandyWorkRow;
  sourcePlan: SandyPlanSnapshot | null;
  sourceCheckpoint: SandyCheckpointSnapshot | null;
  sessionHeadWorkId: string | null;
  bindings: SandyBindingRow[];
  results: SandyResultRow[];
  turnMessages: SandyTurnMessage[];
  selectedToolJournalCount: number;
  selectedToolJournalDigest: string;
};

export type SandyAfterSnapshot = {
  sourceWork: SandyWorkRow;
  captureWork: SandyWorkRow;
  sessionHeadWorkId: string | null;
  monitoringBindingCount: number;
  captureBindingCount: number;
  monitoringResultCount: number;
  captureResultCount: number;
  monitoringResultSequence: number[];
  captureResultSequence: number[];
  dispositionRevisionId: string;
};

export type SandyBackupRecord = {
  bundleDir: string;
  bundleIdentity: string;
  files: SandyFileIdentity[];
  sqliteSnapshotPath: string;
  sqliteSnapshotSha256: string;
  ownerManifestSha256?: string;
};

export type SandyCorrectionStatus = "dry_run" | "applied" | "already_applied";

export type SandyCorrectionResult = {
  status: SandyCorrectionStatus;
  requestFingerprint: string;
  operatorId?: string;
  beforeSnapshotSha256: string;
  afterSnapshotSha256?: string;
  read: SandyCorrectionRead;
  after?: SandyAfterSnapshot;
  backup?: SandyBackupRecord;
  auditId?: string;
};

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function correctionRequestFingerprint(input: SandyCorrectionInput): string {
  return sha256(stableJson({
    version: SANDY_CORRECTION_VERSION,
    recipeVersion: SANDY_RECIPE_VERSION,
    target: inputTarget(input),
    expected: input.expected,
    disposition: input.disposition,
    capturePlan: input.capturePlan ?? null,
    captureCheckpoint: input.captureCheckpoint ?? null,
    backupDir: input.backupDir ?? "",
    ownerStopManifestSha256: input.ownerStopManifestSha256 ?? "",
    operatorReason: input.operatorReason.trim(),
    operatorId: input.operatorId?.trim() ?? "",
  }));
}

export function inputTarget(input: SandyCorrectionTarget): SandyCorrectionTarget {
  return {
    dbPath: input.dbPath,
    sessionId: input.sessionId,
    sourceWorkId: input.sourceWorkId,
    monitoringTurnIds: [...input.monitoringTurnIds] as [string, string],
    captureTurnIds: [...input.captureTurnIds] as [string, string],
  };
}

export function assertCanonicalSandyTarget(input: SandyCorrectionTarget): void {
  const same = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (input.sessionId !== SANDY_SESSION_ID || input.sourceWorkId !== SANDY_SOURCE_WORK_ID ||
    !same(input.monitoringTurnIds, SANDY_MONITORING_TURN_IDS) ||
    !same(input.captureTurnIds, SANDY_CAPTURE_TURN_IDS)) {
    throw new Error(`correction target does not match immutable Sandy recipe ${SANDY_RECIPE_VERSION}`);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJson(record[key])]),
    );
  }
  return value;
}
