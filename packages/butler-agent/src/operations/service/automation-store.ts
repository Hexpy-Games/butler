import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { InboundEnvelope } from "../../test-support/harness/contracts.ts";

export type AutomationStatus = "active" | "paused" | "completed" | "deleted";

export type AutomationSchedule =
  | { type: "once"; run_at: string }
  | { type: "interval"; interval_minutes: number; start_at?: string };

export interface AutomationRecord {
  version: 1;
  id: string;
  title: string;
  prompt: string;
  session_id: string;
  status: AutomationStatus;
  schedule: AutomationSchedule;
  next_run_at: string | null;
  last_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationPreview {
  id: string;
  title: string;
  session_id: string;
  status: AutomationStatus;
  schedule: AutomationSchedule;
  next_run_at: string | null;
  last_run_at: string | null;
  run_count: number;
  prompt_preview: string;
}

export interface ClaimedAutomationRun {
  automation: AutomationPreview;
  envelope: InboundEnvelope;
}

function safeId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(trimmed)) {
    throw new Error("automation id must be 1-100 safe characters");
  }
  return trimmed;
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

function parseDateMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`automation ${field} must be a valid ISO date`);
  return ms;
}

function normalizeSchedule(value: AutomationSchedule): AutomationSchedule {
  if (value.type === "once") {
    return {
      type: "once",
      run_at: new Date(parseDateMs(value.run_at, "run_at")).toISOString(),
    };
  }
  if (value.type === "interval") {
    const interval = Math.trunc(value.interval_minutes);
    if (!Number.isFinite(interval) || interval < 1) {
      throw new Error("automation interval_minutes must be at least 1");
    }
    return {
      type: "interval",
      interval_minutes: interval,
      start_at: value.start_at
        ? new Date(parseDateMs(value.start_at, "start_at")).toISOString()
        : undefined,
    };
  }
  throw new Error("unsupported automation schedule");
}

function initialNextRunAt(schedule: AutomationSchedule, nowMs: number): string {
  if (schedule.type === "once") return schedule.run_at;
  return schedule.start_at ?? new Date(nowMs).toISOString();
}

function nextIntervalRunAt(schedule: Extract<AutomationSchedule, { type: "interval" }>, nowMs: number): string {
  const intervalMs = schedule.interval_minutes * 60_000;
  const startMs = Date.parse(schedule.start_at ?? new Date(nowMs).toISOString());
  const elapsedMs = nowMs - startMs;
  const skippedIntervals = elapsedMs < 0 ? 0 : Math.floor(elapsedMs / intervalMs) + 1;
  const nextMs = startMs + skippedIntervals * intervalMs;
  return new Date(nextMs).toISOString();
}

function previewPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function toPreview(record: AutomationRecord): AutomationPreview {
  return {
    id: record.id,
    title: record.title,
    session_id: record.session_id,
    status: record.status,
    schedule: record.schedule,
    next_run_at: record.next_run_at,
    last_run_at: record.last_run_at,
    run_count: record.run_count,
    prompt_preview: previewPrompt(record.prompt),
  };
}

function envelopeFor(record: AutomationRecord, runAt: string): InboundEnvelope {
  const runNumber = record.run_count + 1;
  return {
    eventId: `automation:${record.id}:${runNumber}`,
    transport: "automation",
    accountId: "local",
    peer: {
      kind: "dm",
      id: record.session_id,
    },
    sender: {
      id: "butler-automation",
      displayName: "Butler Automation",
    },
    message: {
      id: `automation:${record.id}:${runNumber}`,
      text: record.prompt,
      timestamp: runAt,
    },
    routingHints: {
      sessionId: record.session_id,
    },
    raw: {
      automationId: record.id,
      runNumber,
    },
  };
}

export class AutomationStore {
  readonly automationsDir: string;

  constructor(readonly butlerData: string) {
    this.automationsDir = join(butlerData, "automations");
  }

  pathFor(id: string): string {
    return join(this.automationsDir, `${safeId(id)}.json`);
  }

  read(id: string): AutomationRecord | null {
    return readJson<AutomationRecord>(this.pathFor(id));
  }

  list(options: { includeDeleted?: boolean } = {}): AutomationPreview[] {
    if (!existsSync(this.automationsDir)) return [];
    return readdirSync(this.automationsDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJson<AutomationRecord>(join(this.automationsDir, entry)))
      .filter((record): record is AutomationRecord => Boolean(record))
      .filter((record) => options.includeDeleted || record.status !== "deleted")
      .sort((a, b) => (a.next_run_at ?? "").localeCompare(b.next_run_at ?? ""))
      .map(toPreview);
  }

  create(input: {
    id?: string;
    title?: string;
    prompt: string;
    sessionId: string;
    schedule: AutomationSchedule;
    now?: Date;
  }): AutomationPreview {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const prompt = input.prompt.trim();
    const sessionId = input.sessionId.trim();
    if (!prompt) throw new Error("automation prompt must be non-empty");
    if (!sessionId) throw new Error("automation session_id must be non-empty");
    const schedule = normalizeSchedule(input.schedule);
    const id = safeId(input.id?.trim() || `automation-${now.getTime()}-${randomUUID().slice(0, 8)}`);
    if (existsSync(this.pathFor(id))) throw new Error(`automation ${id} already exists`);
    const record: AutomationRecord = {
      version: 1,
      id,
      title: input.title?.trim() || prompt.slice(0, 80),
      prompt,
      session_id: sessionId,
      status: "active",
      schedule,
      next_run_at: initialNextRunAt(schedule, now.getTime()),
      last_run_at: null,
      run_count: 0,
      created_at: nowIso,
      updated_at: nowIso,
    };
    atomicWriteJson(this.pathFor(id), record);
    return toPreview(record);
  }

  delete(id: string, now = new Date()): AutomationPreview {
    const record = this.read(id);
    if (!record) throw new Error(`automation ${id} not found`);
    const updated: AutomationRecord = {
      ...record,
      status: "deleted",
      next_run_at: null,
      updated_at: now.toISOString(),
    };
    atomicWriteJson(this.pathFor(id), updated);
    return toPreview(updated);
  }

  runNow(id: string, now = new Date()): ClaimedAutomationRun {
    const record = this.read(id);
    if (!record) throw new Error(`automation ${id} not found`);
    if (record.status !== "active") {
      throw new Error(`automation ${id} is ${record.status}; only active automations can be run`);
    }
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const envelope = envelopeFor(record, nowIso);
    const updated: AutomationRecord = {
      ...record,
      status: record.schedule.type === "once" ? "completed" : "active",
      next_run_at: record.schedule.type === "once"
        ? null
        : nextIntervalRunAt(record.schedule, nowMs),
      last_run_at: nowIso,
      run_count: record.run_count + 1,
      updated_at: nowIso,
    };
    atomicWriteJson(this.pathFor(record.id), updated);
    return {
      automation: toPreview(updated),
      envelope,
    };
  }

  claimDue(now = new Date()): ClaimedAutomationRun[] {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const due: ClaimedAutomationRun[] = [];
    for (const preview of this.list()) {
      const record = this.read(preview.id);
      if (!record || record.status !== "active" || !record.next_run_at) continue;
      if (parseDateMs(record.next_run_at, "next_run_at") > nowMs) continue;
      const envelope = envelopeFor(record, nowIso);
      const updated: AutomationRecord = {
        ...record,
        status: record.schedule.type === "once" ? "completed" : "active",
        next_run_at: record.schedule.type === "once"
          ? null
          : nextIntervalRunAt(record.schedule, nowMs),
        last_run_at: nowIso,
        run_count: record.run_count + 1,
        updated_at: nowIso,
      };
      atomicWriteJson(this.pathFor(record.id), updated);
      due.push({
        automation: toPreview(updated),
        envelope,
      });
    }
    return due;
  }
}
