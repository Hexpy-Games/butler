import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { TaskStore, workSafetyForTask, type TaskRecord } from "./task-store.ts";

export type WorkOrchestrationStatus =
  | "draft"
  | "running"
  | "ready_for_report"
  | "reported"
  | "failed"
  | "cancelled";

export type WorkStreamStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";
export type WorkStreamKind = "implementation" | "setup" | "planning" | "investigation" | "review";

export interface WorkStreamInput {
  id?: string;
  kind?: WorkStreamKind;
  role: string;
  objective: string;
  acceptance_criteria: string[];
  depends_on?: string[];
}

export interface WorkStreamRecord {
  id: string;
  kind?: WorkStreamKind;
  role: string;
  objective: string;
  acceptance_criteria: string[];
  depends_on: string[];
  status: WorkStreamStatus;
  worker_task_id: string | null;
  result_summary: string | null;
  updated_at: string;
}

export interface WorkOrchestrationRecord {
  version: 1;
  id: string;
  title: string;
  goal: string;
  origin_session_id: string | null;
  status: WorkOrchestrationStatus;
  streams: WorkStreamRecord[];
  public_report: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkOrchestrationSummary {
  id: string;
  title: string;
  goal: string;
  status: WorkOrchestrationStatus;
  stream_count: number;
  counts: Record<WorkStreamStatus, number>;
  completion_claim_allowed: boolean;
  safe_to_report: boolean;
  guard_reason: string | null;
}

function safeId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(trimmed)) throw new Error("orchestration id must be 1-100 safe characters");
  return trimmed;
}

function compact(value: string, limit = 600): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function normalizeStreamKind(value: unknown): WorkStreamKind {
  if (
    value === "setup" ||
    value === "planning" ||
    value === "investigation" ||
    value === "review"
  ) {
    return value;
  }
  return "implementation";
}

function streamKind(stream: WorkStreamRecord): WorkStreamKind {
  return normalizeStreamKind(stream.kind);
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function normalizeStream(input: WorkStreamInput, index: number, nowIso: string): WorkStreamRecord {
  const id = safeId(input.id?.trim() || `stream-${index + 1}`);
  const role = input.role.trim();
  const objective = input.objective.trim();
  const acceptanceCriteria = input.acceptance_criteria.map((item) => item.trim()).filter(Boolean);
  if (!role) throw new Error(`work stream ${id} requires role`);
  if (!objective) throw new Error(`work stream ${id} requires objective`);
  if (acceptanceCriteria.length === 0) throw new Error(`work stream ${id} requires acceptance criteria`);
  return {
    id,
    kind: normalizeStreamKind(input.kind),
    role,
    objective,
    acceptance_criteria: acceptanceCriteria,
    depends_on: (input.depends_on ?? []).map((item) => item.trim()).filter(Boolean).map(safeId),
    status: "pending",
    worker_task_id: null,
    result_summary: null,
    updated_at: nowIso,
  };
}

function validateStreams(streams: WorkStreamRecord[]): void {
  const ids = new Set<string>();
  for (const stream of streams) {
    if (ids.has(stream.id)) throw new Error(`duplicate work stream id: ${stream.id}`);
    ids.add(stream.id);
  }
  for (const stream of streams) {
    for (const dep of stream.depends_on) {
      if (!ids.has(dep)) throw new Error(`work stream ${stream.id} depends on unknown stream ${dep}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(streams.map((stream) => [stream.id, stream]));
  function visit(id: string, trail: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`work stream dependency cycle detected: ${[...trail, id].join(" -> ")}`);
    visiting.add(id);
    const stream = byId.get(id);
    for (const dep of stream?.depends_on ?? []) visit(dep, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const stream of streams) visit(stream.id, []);
}

function terminal(stream: WorkStreamRecord): boolean {
  return stream.status === "done" || stream.status === "failed" || stream.status === "skipped" || stream.status === "cancelled";
}

function canCompleteNonImplementationStream(stream: WorkStreamRecord, task: TaskRecord): boolean {
  if (streamKind(stream) === "implementation") return false;
  const evidence = task.completionEvidence;
  if (evidence.has_final_blocker || evidence.has_environment_blocker) return false;
  if (!evidence.has_report_evidence) return false;
  return Boolean(task.observedResult?.trim() || task.result?.trim());
}

function summarize(record: WorkOrchestrationRecord): WorkOrchestrationSummary {
  const counts: Record<WorkStreamStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const stream of record.streams) counts[stream.status] += 1;
  if (record.status === "cancelled") {
    return {
      id: record.id,
      title: record.title,
      goal: record.goal,
      status: record.status,
      stream_count: record.streams.length,
      counts,
      safe_to_report: false,
      completion_claim_allowed: false,
      guard_reason: "Work orchestration was cancelled.",
    };
  }
  const allTerminal = record.streams.every(terminal);
  const completionClaimAllowed = allTerminal && record.streams.every((stream) => stream.status === "done" || stream.status === "skipped");
  return {
    id: record.id,
    title: record.title,
    goal: record.goal,
    status: record.status,
    stream_count: record.streams.length,
    counts,
    safe_to_report: allTerminal,
    completion_claim_allowed: completionClaimAllowed,
    guard_reason: allTerminal ? null : "Some work streams are still pending or running.",
  };
}

function nextStatus(record: WorkOrchestrationRecord): WorkOrchestrationStatus {
  if (record.status === "cancelled" || record.status === "reported") return record.status;
  if (record.streams.some((stream) => stream.status === "running")) return "running";
  if (record.streams.every(terminal)) {
    return record.streams.every((stream) => stream.status === "done" || stream.status === "skipped")
      ? "ready_for_report"
      : "failed";
  }
  return record.streams.some((stream) => stream.status !== "pending") ? "running" : "draft";
}

export class WorkOrchestrationStore {
  readonly dir: string;

  constructor(readonly butlerData: string) {
    this.dir = join(butlerData, "orchestrations");
  }

  pathFor(id: string): string {
    return join(this.dir, `${safeId(id)}.json`);
  }

  read(id: string): WorkOrchestrationRecord | null {
    return readJson<WorkOrchestrationRecord>(this.pathFor(id));
  }

  list(): WorkOrchestrationSummary[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJson<WorkOrchestrationRecord>(join(this.dir, entry)))
      .filter((record): record is WorkOrchestrationRecord => Boolean(record))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(summarize);
  }

  records(): WorkOrchestrationRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJson<WorkOrchestrationRecord>(join(this.dir, entry)))
      .filter((record): record is WorkOrchestrationRecord => Boolean(record))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  findByWorkerTaskId(workerTaskId: string): {
    record: WorkOrchestrationRecord;
    stream: WorkStreamRecord;
  } | null {
    const safeWorkerTaskId = workerTaskId.trim();
    if (!safeWorkerTaskId) return null;
    for (const record of this.records()) {
      const stream = record.streams.find((item) => item.worker_task_id === safeWorkerTaskId);
      if (stream) return { record, stream };
    }
    return null;
  }

  create(input: {
    id?: string;
    title?: string;
    goal: string;
    originSessionId?: string | null;
    streams: WorkStreamInput[];
    now?: Date;
  }): WorkOrchestrationSummary {
    const nowIso = (input.now ?? new Date()).toISOString();
    const goal = input.goal.trim();
    if (!goal) throw new Error("work orchestration requires goal");
    if (input.streams.length === 0) throw new Error("work orchestration requires streams");
    const id = safeId(input.id?.trim() || `orchestration-${Date.now()}-${randomUUID().slice(0, 8)}`);
    if (existsSync(this.pathFor(id))) throw new Error(`work orchestration ${id} already exists`);
    const streams = input.streams.map((stream, index) => normalizeStream(stream, index, nowIso));
    validateStreams(streams);
    const record: WorkOrchestrationRecord = {
      version: 1,
      id,
      title: input.title?.trim() || goal.slice(0, 80),
      goal,
      origin_session_id: input.originSessionId?.trim() || null,
      status: "draft",
      streams,
      public_report: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    atomicWriteJson(this.pathFor(id), record);
    return summarize(record);
  }

  readyStreams(id: string): WorkStreamRecord[] {
    const record = this.read(id);
    if (!record) throw new Error(`work orchestration ${id} not found`);
    if (record.status === "cancelled" || record.status === "reported") return [];
    const byId = new Map(record.streams.map((stream) => [stream.id, stream]));
    return record.streams.filter((stream) =>
      stream.status === "pending" &&
      stream.depends_on.every((dep) => byId.get(dep)?.status === "done"),
    );
  }

  markDispatched(id: string, dispatches: Array<{ stream_id: string; worker_task_id: string }>, now = new Date()): WorkOrchestrationSummary {
    const record = this.read(id);
    if (!record) throw new Error(`work orchestration ${id} not found`);
    if (record.status === "cancelled" || record.status === "reported") {
      throw new Error(`work orchestration ${id} is ${record.status}`);
    }
    const nowIso = now.toISOString();
    const workerByStream = new Map(dispatches.map((item) => [item.stream_id, item.worker_task_id]));
    const updated: WorkOrchestrationRecord = {
      ...record,
      streams: record.streams.map((stream) => {
        const workerTaskId = workerByStream.get(stream.id);
        if (!workerTaskId) return stream;
        if (stream.status !== "pending") throw new Error(`work stream ${stream.id} is ${stream.status}; only pending streams can dispatch`);
        return {
          ...stream,
          status: "running",
          worker_task_id: workerTaskId,
          updated_at: nowIso,
        };
      }),
      updated_at: nowIso,
    };
    updated.status = nextStatus(updated);
    atomicWriteJson(this.pathFor(id), updated);
    return summarize(updated);
  }

  syncFromTasks(id: string, taskStore = new TaskStore(this.butlerData), now = new Date()): WorkOrchestrationSummary {
    const record = this.read(id);
    if (!record) throw new Error(`work orchestration ${id} not found`);
    if (record.status === "cancelled" || record.status === "reported") return summarize(record);
    const nowIso = now.toISOString();
    const updated: WorkOrchestrationRecord = {
      ...record,
      streams: record.streams.map((stream) => {
        if (stream.status !== "running" || !stream.worker_task_id) return stream;
        const task = taskStore.read(stream.worker_task_id);
        if (!task) return stream;
        if (task.status === "DONE" || task.status === "REVIEWED") {
          const safety = workSafetyForTask(task);
          if (!safety.safe_to_report || !safety.completion_claim_allowed) {
            if (canCompleteNonImplementationStream(stream, task)) {
              return {
                ...stream,
                status: "done",
                result_summary: compact(task.observedResult ?? task.result ?? "Worker completed non-implementation stream."),
                updated_at: nowIso,
              };
            }
            return {
              ...stream,
              status: "failed",
              result_summary: compact(safety.guard_reason ?? "Worker completion evidence was insufficient for this stream."),
              updated_at: nowIso,
            };
          }
          return {
            ...stream,
            status: "done",
            result_summary: compact(task.observedResult ?? task.result ?? "Worker completed without a result summary."),
            updated_at: nowIso,
          };
        }
        if (task.status === "FAILED") {
          return {
            ...stream,
            status: "failed",
            result_summary: compact(task.observedResult ?? task.result ?? task.logTail ?? "Worker failed without result evidence."),
            updated_at: nowIso,
          };
        }
        return stream;
      }),
      updated_at: nowIso,
    };
    updated.status = nextStatus(updated);
    atomicWriteJson(this.pathFor(id), updated);
    return summarize(updated);
  }

  writeReport(id: string, report: string, now = new Date()): WorkOrchestrationSummary {
    const record = this.read(id);
    if (!record) throw new Error(`work orchestration ${id} not found`);
    if (record.status === "cancelled") throw new Error("cancelled work orchestration cannot be reported");
    const trimmedReport = report.trim();
    if (!trimmedReport) throw new Error("work orchestration report must be non-empty");
    if (!record.streams.every(terminal)) {
      throw new Error("work orchestration report requires all streams to be terminal");
    }
    const nowIso = now.toISOString();
    const complete = record.streams.every((stream) => stream.status === "done" || stream.status === "skipped");
    const updated: WorkOrchestrationRecord = {
      ...record,
      status: complete ? "reported" : "failed",
      public_report: trimmedReport,
      updated_at: nowIso,
    };
    atomicWriteJson(this.pathFor(id), updated);
    return summarize(updated);
  }

  cancel(id: string, now = new Date()): WorkOrchestrationSummary {
    const record = this.read(id);
    if (!record) throw new Error(`work orchestration ${id} not found`);
    if (record.status === "cancelled") return summarize(record);
    const nowIso = now.toISOString();
    const updated: WorkOrchestrationRecord = {
      ...record,
      status: "cancelled",
      streams: record.streams.map((stream) =>
        terminal(stream)
          ? stream
          : {
            ...stream,
            status: "cancelled",
            updated_at: nowIso,
          }),
      updated_at: nowIso,
    };
    atomicWriteJson(this.pathFor(id), updated);
    return summarize(updated);
  }

  summary(id: string): WorkOrchestrationSummary {
    const record = this.read(id);
    if (!record) throw new Error(`work orchestration ${id} not found`);
    return summarize(record);
  }
}

export function orchestrationWorkerPrompt(input: {
  orchestration: WorkOrchestrationRecord;
  stream: WorkStreamRecord;
}): string {
  return [
    "Execute Butler orchestration work stream.",
    "",
    `Orchestration: ${input.orchestration.title}`,
    `Goal: ${input.orchestration.goal}`,
    `Stream: ${input.stream.id}`,
    `Stream kind: ${streamKind(input.stream)}`,
    `Role: ${input.stream.role}`,
    "",
    "Objective:",
    input.stream.objective,
    "",
    "Acceptance Criteria:",
    ...input.stream.acceptance_criteria.map((criterion) => `- ${criterion}`),
    "",
    "Instructions:",
    "- Follow Butler's Turn Cognition Cycle inside this stream: 구상, 계획, 실행, 검토, 취합 및 정리, 보고.",
    "- Keep your status and final evidence aligned with this stream's phase and concrete step.",
    "- Stay within this stream objective.",
    "- Produce concise evidence for every acceptance criterion.",
    "- Do not report to the user directly; Butler will synthesize reviewed outcomes.",
  ].join("\n");
}
