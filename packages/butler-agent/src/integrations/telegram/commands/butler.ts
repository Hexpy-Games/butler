// Thin adapters onto butler state. Handlers call these instead of touching
// fs directly so a test can point BUTLER_HOME at a temp dir and drive the
// full interaction loop without a running system.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { listServices } from "../../../operations/service/native-service-supervisor.ts";
import { defaultSchedulerJobs } from "../../../operations/scheduler/native-scheduler.ts";
import { cognitionMemoryRoot } from "../../../agent/cognition/paths.ts";
import { butlerAgentResourcesPath } from "../../../runtime/paths.ts";

const exec = promisify(execCb);

export function butlerHome(): string {
  return process.env.BUTLER_HOME ?? process.cwd();
}

export function butlerData(): string {
  return process.env.BUTLER_DATA ?? join(homedir(), ".butler");
}

// Compatibility exports for older tests/helpers. Live code should prefer the
// functions above so environment changes are observed at runtime.
export const BUTLER_HOME = butlerHome();
export const BUTLER_DATA = butlerData();

function tasksDir(): string {
  return join(butlerData(), "tasks");
}

function memoryDir(): string {
  return cognitionMemoryRoot(butlerData());
}

function sessionSyncPath(): string {
  return join(memoryDir(), "db", "session-sync-offset.json");
}

export type PersonaLocale = "en" | "ko";

function normalizePersonaLocale(value: unknown): PersonaLocale {
  return value === "ko" ? "ko" : "en";
}

function readButlerConfig(): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(butlerConfigPath(), "utf8"));
  } catch {
    return null;
  }
}

function activePersonaLocale(): PersonaLocale {
  return normalizePersonaLocale(readButlerConfig()?.user?.language);
}

function personaTemplatesRoot(): string {
  const repoResourcesRoot = butlerAgentResourcesPath(butlerHome(), "personas", "templates");
  if (existsSync(repoResourcesRoot)) return repoResourcesRoot;
  return join(butlerHome(), "personas", "templates");
}

function personaTemplatesDir(locale: PersonaLocale = activePersonaLocale()): string {
  return join(personaTemplatesRoot(), locale);
}

function activePersonaPath(): string {
  return join(butlerData(), "personas", "active.md");
}

function butlerConfigPath(): string {
  return join(butlerData(), "butler.config.json");
}

export const VALID_MODELS = ["openai/gpt-5.5-codex", "openai/gpt-5.5", "openai/gpt-5.4", "openai/auto:codex-latest"] as const;
export type ModelAlias = (typeof VALID_MODELS)[number];

// ── model ────────────────────────────────────────────────────────────────────
// Model settings live in butler.config.json under system.butlerModel / system.workerModel.
// Legacy system.defaultModel is read as a fallback only.

function readModelField(field: "butlerModel" | "workerModel"): string {
  try {
    const cfg = JSON.parse(readFileSync(butlerConfigPath(), "utf8"));
    const sys = cfg?.system ?? {};
    if (typeof sys[field] === "string" && sys[field]) return sys[field];
    if (field === "butlerModel" && typeof sys.defaultModel === "string" && sys.defaultModel) {
      return sys.defaultModel;
    }
  } catch {}
  return "openai/gpt-5.5-codex";
}

function writeModelField(field: "butlerModel" | "workerModel", model: string): void {
  if (
    !(VALID_MODELS as readonly string[]).includes(model) &&
    !/^openai\/(auto:codex-latest|gpt-5[a-z0-9.-]*)$/i.test(model)
  ) {
    throw new Error(`invalid model: ${model}`);
  }
  let cfg: Record<string, any> = {};
  try { cfg = JSON.parse(readFileSync(butlerConfigPath(), "utf8")); } catch {}
  if (!cfg.system || typeof cfg.system !== "object") cfg.system = {};
  cfg.system[field] = model;
  mkdirSync(join(butlerConfigPath(), ".."), { recursive: true });
  writeFileSync(butlerConfigPath(), JSON.stringify(cfg, null, 2) + "\n");
}

export function getWorkerModel(): string { return readModelField("workerModel"); }
export function getButlerModel(): string { return readModelField("butlerModel"); }
export function setWorkerModel(model: string): void { writeModelField("workerModel", model); }
export function setButlerModel(model: string): void { writeModelField("butlerModel", model); }

// ── persona ──────────────────────────────────────────────────────────────────

export function listPersonaPresets(locale: PersonaLocale = activePersonaLocale()): string[] {
  const dir = existsSync(personaTemplatesDir(locale)) ? personaTemplatesDir(locale) : personaTemplatesDir("en");
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(/\.md$/, ""))
      .sort();
  } catch { return []; }
}

export function getActivePersona(): { name: string; base: string | null; baseLocale: string | null } {
  try {
    const raw = readFileSync(activePersonaPath(), "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
    if (!fm) return { name: "unknown", base: null, baseLocale: null };
    const nameMatch = /name:\s*(.+)/.exec(fm[1]!);
    const baseMatch = /base:\s*(.+)/.exec(fm[1]!);
    const baseLocaleMatch = /base_locale:\s*(.+)/.exec(fm[1]!);
    return {
      name: nameMatch ? nameMatch[1]!.trim() : "unknown",
      base: baseMatch ? baseMatch[1]!.trim() : null,
      baseLocale: baseLocaleMatch ? baseLocaleMatch[1]!.trim() : null,
    };
  } catch { return { name: "none", base: null, baseLocale: null }; }
}

function resolvePersonaTemplate(name: string, locale: PersonaLocale): { path: string; locale: PersonaLocale } | null {
  const localized = join(personaTemplatesDir(locale), `${name}.md`);
  if (existsSync(localized)) return { path: localized, locale };
  const fallback = join(personaTemplatesDir("en"), `${name}.md`);
  if (existsSync(fallback)) return { path: fallback, locale: "en" };
  return null;
}

export function setPersona(name: string, locale: PersonaLocale = activePersonaLocale()): void {
  const resolved = resolvePersonaTemplate(name, locale);
  if (!resolved) throw new Error(`unknown persona: ${name}`);
  mkdirSync(join(butlerData(), "personas"), { recursive: true });
  const template = readFileSync(resolved.path, "utf8");
  const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(template);
  const body = fmMatch ? fmMatch[2] : template;
  const out =
    `---\nname: active\ndescription: Currently active persona. Copied from preset, freely customizable.\nbase: ${name}\nbase_locale: ${resolved.locale}\n---\n${body}`;
  writeFileSync(activePersonaPath(), out);
  updateConfigField("system.activePersona", name);
  updateConfigField("system.activePersonaLocale", resolved.locale);
}

function updateConfigField(dottedPath: string, value: string): void {
  if (!existsSync(butlerConfigPath())) return;
  let cfg: Record<string, any>;
  try { cfg = JSON.parse(readFileSync(butlerConfigPath(), "utf8")); } catch { return; }
  const parts = dottedPath.split(".");
  let cursor: any = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cursor[parts[i]!] !== "object" || cursor[parts[i]!] === null) cursor[parts[i]!] = {};
    cursor = cursor[parts[i]!];
  }
  cursor[parts[parts.length - 1]!] = value;
  writeFileSync(butlerConfigPath(), JSON.stringify(cfg, null, 2) + "\n");
}

// ── projects ─────────────────────────────────────────────────────────────────

export type ProjectEntry = { name: string; path: string; description?: string };

export function listProjectsFromConfig(): ProjectEntry[] {
  try {
    const cfg = JSON.parse(readFileSync(butlerConfigPath(), "utf8"));
    const list = Array.isArray(cfg.projects) ? cfg.projects : [];
    return list.filter((p: any) => p && typeof p.name === "string");
  } catch { return []; }
}

// ── tasks ────────────────────────────────────────────────────────────────────

export type TaskRow = {
  taskId: string
  status: string
  project: string
  request: string
  pid: string | null
  mtime: number
};

function readTaskFile(taskId: string, file: string): string {
  try { return readFileSync(join(tasksDir(), taskId, file), "utf8").trim(); } catch { return ""; }
}

export function listTaskRows(): TaskRow[] {
  if (!existsSync(tasksDir())) return [];
  const ids = readdirSync(tasksDir());
  const rows: TaskRow[] = [];
  for (const id of ids) {
    const dir = join(tasksDir(), id);
    let mtime: number;
    try { mtime = statSync(dir).mtimeMs; } catch { continue; }
    rows.push({
      taskId: id,
      status: readTaskFile(id, "status") || "UNKNOWN",
      project: readTaskFile(id, "project"),
      request: readTaskFile(id, "request.md").slice(0, 120),
      pid: readTaskFile(id, "pid") || null,
      mtime,
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

export function listRunningTasks(): TaskRow[] {
  return listTaskRows().filter(t => t.status === "RUNNING" || t.status === "PENDING");
}

export async function killTask(taskId: string): Promise<{ ok: boolean; msg: string }> {
  const pid = readTaskFile(taskId, "pid");
  if (!pid) return { ok: false, msg: `no pid for ${taskId}` };
  const pgid = readTaskFile(taskId, "pgid") || pid;
  try {
    // Negative pid = signal the whole process group (kills worker + children).
    await exec(`kill -TERM -${pgid}`);
    return { ok: true, msg: `sent SIGTERM to pgid ${pgid}` };
  } catch (e) {
    return { ok: false, msg: `kill failed: ${(e as Error).message}` };
  }
}

// ── status / restart ─────────────────────────────────────────────────────────

export type ButlerStatus = {
  workerModel: string
  butlerModel: string
  activePersona: string
  runningTasks: number
  pendingTasks: number
  doneTasks: number
  failedTasks: number
  services: string | null
};

export async function getButlerStatus(): Promise<ButlerStatus> {
  const rows = listTaskRows();
  const count = (s: string) => rows.filter(r => r.status === s).length;
  let services: string | null;
  try {
    services = listServices({ butlerHome: butlerHome(), butlerData: butlerData() })
      .map((service) => `${service.serviceId}: ${service.status}`)
      .join(", ") || null;
  } catch { services = null; }
  return {
    workerModel: getWorkerModel(),
    butlerModel: getButlerModel(),
    activePersona: getActivePersona().name,
    runningTasks: count("RUNNING"),
    pendingTasks: count("PENDING"),
    doneTasks: count("DONE"),
    failedTasks: count("FAILED"),
    services,
  };
}

// ── system snapshot (mirrors MCP butler_status) ──────────────────────────────
// Gathers the same data the butler_status MCP tool reports: native uptime, task
// counts by status, and hot-cache file count. Kept here so onStatusCommand can
// surface it without round-tripping through MCP.

export type CronEntry = { name: string; schedule: string; nextRunMs: number | null };

export type SystemSnapshot = {
  uptime: string
  installedAt: string | null
  installedFor: string
  butlerModel: string
  workerModel: string
  projectsCount: number
  lastSessionSync: string | null
  cronsRegistered: number
  nextCron: { name: string; schedule: string } | null
  tasksTotal: number
  tasksRunning: number
  tasksDone: number
  tasksFailed: number
  hotCacheFiles: number
};

function formatDaysHours(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalHours = Math.floor(ms / 3600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days} days ${hours} hours`;
}

function formatLocalDateTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readInstalledAt(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(butlerConfigPath(), "utf8"));
    const raw = cfg?.system?.createdAt ?? cfg?.system?.installedAt;
    if (typeof raw === "string" && raw) return raw;
  } catch {}
  return null;
}

function readProjectsCount(): number {
  try {
    const cfg = JSON.parse(readFileSync(butlerConfigPath(), "utf8"));
    return Array.isArray(cfg.projects) ? cfg.projects.length : 0;
  } catch { return 0; }
}

function readLastSessionSync(): string | null {
  try {
    const st = statSync(sessionSyncPath());
    return formatLocalDateTime(new Date(st.mtimeMs));
  } catch { return null; }
}

// Parse a single cron field (e.g. "*", "0", "1-5", "*/15", "0,30") into the
// set of valid integer values in [min, max]. Returns null on malformed input.
function parseCronField(s: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    const body = stepMatch ? stepMatch[1]! : part;
    if (!Number.isFinite(step) || step <= 0) return null;
    let lo = min, hi = max;
    if (body !== "*") {
      const rangeMatch = body.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        lo = parseInt(rangeMatch[1]!, 10);
        hi = parseInt(rangeMatch[2]!, 10);
      } else {
        const n = parseInt(body, 10);
        if (!Number.isFinite(n)) return null;
        lo = n; hi = n;
      }
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

// Compute the next occurrence (in ms since epoch) of a 5-field cron expression
// strictly after `from`. Returns null for unparseable expressions or if no
// occurrence is found within ~1 year.
export function nextCronRunMs(expr: string, from: Date = new Date()): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const mins = parseCronField(parts[0]!, 0, 59);
  const hours = parseCronField(parts[1]!, 0, 23);
  const doms = parseCronField(parts[2]!, 1, 31);
  const months = parseCronField(parts[3]!, 1, 12);
  const dows = parseCronField(parts[4]!, 0, 6);
  if (!mins || !hours || !doms || !months || !dows) return null;

  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (
      mins.has(t.getMinutes()) &&
      hours.has(t.getHours()) &&
      doms.has(t.getDate()) &&
      months.has(t.getMonth() + 1) &&
      dows.has(t.getDay())
    ) {
      return t.getTime();
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

export function readCronEntries(): CronEntry[] {
  return defaultSchedulerJobs().map((job) => {
    const schedule = `${job.minute} ${job.hour} * * *`;
    return {
      name: job.id,
      schedule,
      nextRunMs: nextCronRunMs(schedule),
    };
  });
}

export function getSystemSnapshot(): SystemSnapshot {
  let uptime = "unknown";
  try {
    const statePath = join(butlerData(), "state", "butler-main-native.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const startedAt = typeof state.startedAt === "string" ? Date.parse(state.startedAt) : Number(state.startedAt);
    if (Number.isFinite(startedAt)) {
      uptime = formatDaysHours(Date.now() - startedAt);
    }
  } catch {}

  let tasksTotal = 0, tasksRunning = 0, tasksDone = 0, tasksFailed = 0;
  try {
    const taskRoot = tasksDir();
    const entries = readdirSync(taskRoot);
    tasksTotal = entries.length;
    for (const e of entries) {
      try {
        const status = readFileSync(join(taskRoot, e, "status"), "utf8").trim();
        if (status === "RUNNING") tasksRunning++;
        else if (status === "DONE") tasksDone++;
        else if (status === "FAILED") tasksFailed++;
      } catch {}
    }
  } catch {}

  let hotCacheFiles = 0;
  try {
    hotCacheFiles = readdirSync(join(memoryDir(), "hot")).filter(f => f.endsWith(".md")).length;
  } catch {}

  const installedAt = readInstalledAt();
  const installedFor = installedAt ? formatDaysHours(Date.now() - Date.parse(installedAt)) : "unknown";

  const crons = readCronEntries();
  // Sort by next run time (soonest first); entries with unparseable schedules
  // drop to the end so a valid upcoming cron wins the "next" slot.
  crons.sort((a, b) => (a.nextRunMs ?? Infinity) - (b.nextRunMs ?? Infinity));
  const next = crons[0];
  const nextCron = next ? { name: next.name, schedule: next.schedule } : null;

  return {
    uptime,
    installedAt,
    installedFor,
    butlerModel: getButlerModel(),
    workerModel: getWorkerModel(),
    projectsCount: readProjectsCount(),
    lastSessionSync: readLastSessionSync(),
    cronsRegistered: crons.length,
    nextCron,
    tasksTotal,
    tasksRunning,
    tasksDone,
    tasksFailed,
    hotCacheFiles,
  };
}

export async function runRestart(): Promise<void> {
  const script = join(butlerHome(), "packages", "butler-agent", "scripts", "service-control.sh");
  if (!existsSync(script)) throw new Error(`restart script missing: ${script}`);
  // Fire-and-forget via nohup so the child survives this command turn.
  const { exec: rawExec } = await import("child_process");
  rawExec(`nohup "${script}" restart >/dev/null 2>&1 &`);
}
