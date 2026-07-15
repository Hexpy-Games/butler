export const APP_FOREGROUND_QUIT_COPY =
  "Butler를 종료하면 실행 중인 작업과 자동화가 중지됩니다.";

const terminalTurnStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const terminalWorkerStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "recoverable",
]);

export function classifyAppForegroundActiveWork({
  navigation,
  workerActivity,
  queues = [],
  readFailed = false,
} = {}) {
  if (readFailed) return activeWorkResult("active_work_unknown", [], [], []);
  const reasons = [];
  const turnIds = [];
  const workerIds = [];
  for (const chat of Array.isArray(navigation?.chats) ? navigation.chats : []) {
    const state = safeString(chat?.active_turn_state);
    if (state && !terminalTurnStates.has(state)) {
      reasons.push("active_turn");
      const turnId = safeId(chat?.active_turn_id ?? chat?.activeTurnId);
      if (turnId) turnIds.push(turnId);
    }
  }
  const workers = Array.isArray(workerActivity?.workers)
    ? workerActivity.workers
    : Array.isArray(workerActivity)
      ? workerActivity
      : [];
  for (const worker of workers) {
    if (worker?.terminal === true) continue;
    const state = safeString(worker?.status ?? worker?.state);
    if (!state || !terminalWorkerStates.has(state)) {
      reasons.push("active_worker");
      const workerId = safeId(worker?.worker_id ?? worker?.id);
      if (workerId) workerIds.push(workerId);
    }
  }
  for (const queue of queues) {
    const items = queue?.items ?? queue?.messages ?? queue?.queued_messages;
    if (Array.isArray(items) && items.length > 0) reasons.push("queued_work");
  }
  return activeWorkResult(
    reasons.length > 0 ? "active_work_detected" : "no_active_work",
    [...new Set(reasons)],
    [...new Set(turnIds)],
    [...new Set(workerIds)],
  );
}

export async function confirmAppForegroundQuit({
  snapshot,
  showMessageBox,
}) {
  if (snapshot?.classification === "no_active_work") return true;
  const result = await showMessageBox({
    type: "warning",
    buttons: ["취소", "Butler 종료"],
    cancelId: 0,
    defaultId: 0,
    message: APP_FOREGROUND_QUIT_COPY,
    detail: snapshot?.classification === "active_work_unknown"
      ? "실행 중인 작업 상태를 확인할 수 없습니다."
      : "종료 전에 실행 중인 작업을 중지합니다.",
  });
  return result?.response === 1;
}

function activeWorkResult(classification, reasons, turnIds, workerIds) {
  return {
    classification,
    reasons,
    turn_ids: turnIds,
    worker_ids: workerIds,
    raw_text_included: false,
  };
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeId(value) {
  const id = safeString(value);
  return id && /^[A-Za-z0-9._:-]{1,160}$/u.test(id) ? id : null;
}
