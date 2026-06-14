/**
 * watchdog.ts — Butler process watchdog
 *
 * Runs every 1 minute and performs:
 * 1. Dead worker cleanup      — RUNNING tasks with dead PIDs → FAILED
 * 2. Timeout enforcement      — worker processes over threshold → killed
 * 3. Telegram polling check   — if getUpdates succeeds (no 409) → restart butler
 * 4. Agent-browser cleanup    — daemon processes older than 1h → killed
 * 5. Orchestrator liveness    — native main pid missing → trigger start-butler.sh
 * 6. MCP server liveness      — MCP dead while butler-main is alive → Telegram alert
 * 7. Orphan MCP server reap   — kill MCP whose parent host is dead
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readdirSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { $ } from "bun";
import { checkStewardLiveness } from "./checks/steward-liveness.ts";
import { checkButlerMainApi } from "./checks/butler-main-api.ts";
import { getNativeMainStatePath, isPidRunning, readNativeMainState } from "../../integrations/providers/native-main-state.ts";
import {
  defaultNativeServiceSpecs,
  listServices,
  readServiceState,
  startService,
} from "../../operations/service/native-service-supervisor.ts";
import { butlerAgentScriptPath } from "../../runtime/paths.ts";

// ── Config ────────────────────────────────────────────────────────────────────

const BUTLER_HOME = process.env.BUTLER_HOME || process.cwd();
const BUTLER_DATA = process.env.BUTLER_DATA || join(homedir(), ".butler");
const TASKS_DIR = join(BUTLER_DATA, "tasks");
const LOGS_DIR = join(BUTLER_DATA, "logs");
const LOG_FILE = join(LOGS_DIR, "watchdog.log");

const STATE_DIR = join(BUTLER_DATA, "state");
const MCP_HEALTH_STATE_FILE = join(STATE_DIR, "watchdog-mcp-health.json");

const INTERVAL_MS = 1 * 60 * 1000; // 1 minute
const BROWSER_DAEMON_MAX_SECS = 3600; // 1 hour

const WORKER_TIMEOUT_SEC = parseInt(process.env.WORKER_TIMEOUT || "600", 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SINGLETON_DISABLED = process.env.BUTLER_WATCHDOG_DISABLE_SINGLETON === "true";
const SERVICE_LIVENESS_DISABLED = process.env.BUTLER_WATCHDOG_DISABLE_SERVICE_LIVENESS === "true";

// ── Pure/exported functions (testable) ───────────────────────────────────────

export function formatLogLine(msg: string, date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `[${y}-${mo}-${d} ${h}:${mi}:${s}] [watchdog] ${msg}`;
}

export function calcTimeoutSecs(workerTimeoutSec: number): number {
  return Math.floor(workerTimeoutSec * 1.5);
}

export type TelegramHealthResult = "healthy" | "dead" | "conflict";

/**
 * Parse a Telegram getUpdates response.
 * - conflict: another instance holds the polling slot (409) → no restart
 * - dead:     ok:true → nobody else is polling → butler polling is dead → restart
 * - healthy:  any other error (network, auth, etc.) → assume ok, don't restart
 */
export function parseTelegramHealth(response: {
  ok?: boolean;
  error_code?: number;
  description?: string;
}): TelegramHealthResult {
  if (response.error_code === 409) return "conflict";
  if (response.description?.includes("Conflict")) return "conflict";
  if (response.ok === true) return "dead";
  return "healthy";
}

// ── Injectable deps for checkDeadWorkers (enables unit testing) ──────────────

export interface WatchdogDeps {
  listDir(dir: string): string[];
  fileExists(path: string): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  isPidAlive(pid: number): boolean;
  isProcessGroupAlive?(pgid: number): boolean;
  log(msg: string): void;
}

export async function checkDeadWorkers(
  tasksDir: string,
  deps: WatchdogDeps,
): Promise<number> {
  let actions = 0;
  let entries: string[];
  try {
    entries = deps.listDir(tasksDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const taskDir = join(tasksDir, entry);
    const statusFile = join(taskDir, "status");
    const pidFile = join(taskDir, "pid");
    const pgidFile = join(taskDir, "pgid");

    if (!deps.fileExists(statusFile)) continue;
    const status = deps.readFile(statusFile);
    if (status !== "RUNNING") continue;

    const pidStr = deps.fileExists(pidFile) ? deps.readFile(pidFile)?.trim() : "";
    const pgidStr = deps.fileExists(pgidFile) ? deps.readFile(pgidFile)?.trim() : "";
    const pid = pidStr ? parseInt(pidStr, 10) : NaN;
    const pgid = pgidStr ? parseInt(pgidStr, 10) : NaN;

    if (!isNaN(pid) && deps.isPidAlive(pid)) continue;
    if (!isNaN(pgid) && deps.isProcessGroupAlive?.(pgid)) continue;
    if (isNaN(pid) && isNaN(pgid)) continue;

    deps.writeFile(statusFile, "RECOVERABLE");
    if (isNaN(pid)) {
      deps.log(`Task ${entry}: PGID ${pgid} dead before worker PID recorded → marked RECOVERABLE`);
    } else {
      deps.log(`Task ${entry}: PID ${pid} dead → marked RECOVERABLE`);
    }
    actions++;
  }

  return actions;
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(LOG_FILE, formatLogLine(msg) + "\n", "utf8");
  } catch {
    process.stderr.write(formatLogLine(msg) + "\n");
  }
}

// ── Check 1: Dead workers (production deps) ───────────────────────────────────

const productionDeps: WatchdogDeps = {
  listDir: (dir) => readdirSync(dir),
  fileExists: (path) => existsSync(path),
  readFile: (path) => {
    try { return Bun.file(path).text() as any; } catch { return null; }
  },
  writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  isPidAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  isProcessGroupAlive: (pgid) => {
    try { process.kill(-pgid, 0); return true; } catch { return false; }
  },
  log,
};

// We need sync readFile for production deps — override with sync version
productionDeps.readFile = (path) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

// ── Check 2: Worker timeout enforcement ──────────────────────────────────────

async function checkWorkerTimeouts(thresholdSecs: number): Promise<number> {
  let actions = 0;

  let pgrepResult: { stdout: Buffer };
  try {
    pgrepResult = await $`pgrep -f "run-worker.ts"`.quiet().nothrow() as any;
  } catch {
    return 0;
  }

  const pids = pgrepResult.stdout
    .toString()
    .trim()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  for (const pid of pids) {
    try {
      const elapsedResult = await $`ps -o etimes= -p ${pid}`.quiet().nothrow() as any;
      const elapsed = parseInt(elapsedResult.stdout.toString().trim(), 10);
      if (isNaN(elapsed) || elapsed <= thresholdSecs) continue;

      const cmdResult = await $`ps -o command= -p ${pid}`.quiet().nothrow() as any;
      const cmd = cmdResult.stdout.toString().trim().slice(0, 80);

      const pgidResult = await $`ps -o pgid= -p ${pid}`.quiet().nothrow() as any;
      const pgid = parseInt(pgidResult.stdout.toString().trim(), 10);

      if (!isNaN(pgid) && pgid > 1) {
        try {
          process.kill(-pgid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 1000));
          try { process.kill(-pgid, "SIGKILL"); } catch {}
          log(`Killed worker PGID ${pgid} (PID ${pid}, elapsed ${elapsed}s): ${cmd}`);
          actions++;
          continue;
        } catch {}
      }

      process.kill(pid, "SIGKILL");
      log(`Killed worker PID ${pid} (elapsed ${elapsed}s): ${cmd}`);
      actions++;
    } catch {}
  }

  return actions;
}

// ── Check 3: Telegram polling health ─────────────────────────────────────────

/**
 * checkTelegramHealth — checks bot reachability via getMe (not getUpdates).
 *
 * parseTelegramHealth (above) interprets getUpdates responses to decide if
 * the polling process is alive. checkTelegramHealth is different: it calls
 * getMe to verify the bot token is valid and the API is reachable, then
 * tracks degradation state and sends a recovery notification when the bot
 * comes back online.
 */

export interface TelegramHealthDeps {
  fetchGetMe(): Promise<{ ok?: boolean }>;
  notify(text: string): Promise<void>;
  log(msg: string): void;
  now?(): number;
}

// ── Health state machine (spec 07) ──────────────────────────────────────────

export enum HealthState {
  HEALTHY = "HEALTHY",
  PENDING = "PENDING",
  FIRING = "FIRING",
  RECOVERING = "RECOVERING",
}

export interface HealthCheckConfig {
  intervalMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  keepFiringForMs: number;
  startupGracePeriod: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthCheckConfig = {
  intervalMs: 5 * 60 * 1000,
  failureThreshold: 3,
  recoveryThreshold: 2,
  keepFiringForMs: 10 * 60 * 1000,
  startupGracePeriod: 1,
};

interface WatchdogState {
  healthState: HealthState;
  consecutiveFails: number;
  consecutiveOk: number;
  firingStartedAt: number;
  graceRemaining: number;
}

const _state: WatchdogState = {
  healthState: HealthState.HEALTHY,
  consecutiveFails: 0,
  consecutiveOk: 0,
  firingStartedAt: 0,
  graceRemaining: DEFAULT_HEALTH_CONFIG.startupGracePeriod,
};

/** Exported for testing — resets the internal health state. */
export function _resetTelegramHealthState(): void {
  _state.healthState = HealthState.HEALTHY;
  _state.consecutiveFails = 0;
  _state.consecutiveOk = 0;
  _state.firingStartedAt = 0;
  _state.graceRemaining = DEFAULT_HEALTH_CONFIG.startupGracePeriod;
}

/** Exported for testing — returns current health state. */
export function _getHealthState(): HealthState {
  return _state.healthState;
}

/** Pure state transition logic for health checks. */
export function processHealthResult(
  ok: boolean,
  now: number,
  config: HealthCheckConfig = DEFAULT_HEALTH_CONFIG,
): { notify?: string } {
  // Grace period: skip processing
  if (_state.graceRemaining > 0) {
    _state.graceRemaining--;
    return {};
  }

  switch (_state.healthState) {
    case HealthState.HEALTHY:
      if (ok) return {};
      _state.healthState = HealthState.PENDING;
      _state.consecutiveFails = 1;
      return {};

    case HealthState.PENDING:
      if (ok) {
        _state.healthState = HealthState.HEALTHY;
        _state.consecutiveFails = 0;
        return {};
      }
      _state.consecutiveFails++;
      if (_state.consecutiveFails >= config.failureThreshold) {
        _state.healthState = HealthState.FIRING;
        _state.firingStartedAt = now;
        _state.consecutiveFails = 0;
        return { notify: "down" };
      }
      return {};

    case HealthState.FIRING:
      if (ok) {
        _state.healthState = HealthState.RECOVERING;
        _state.consecutiveOk = 1;
      }
      return {};

    case HealthState.RECOVERING:
      if (!ok) {
        _state.healthState = HealthState.FIRING;
        _state.consecutiveOk = 0;
        _state.firingStartedAt = now;
        return {};
      }
      _state.consecutiveOk++;
      if (
        _state.consecutiveOk >= config.recoveryThreshold &&
        now - _state.firingStartedAt >= config.keepFiringForMs
      ) {
        _state.healthState = HealthState.HEALTHY;
        _state.consecutiveOk = 0;
        _state.consecutiveFails = 0;
        _state.firingStartedAt = 0;
        return { notify: "recovery" };
      }
      return {};
  }
}

export async function checkTelegramHealth(deps?: TelegramHealthDeps): Promise<void> {
  const d: TelegramHealthDeps = deps ?? {
    fetchGetMe: async () => {
      if (!BOT_TOKEN) throw new Error("no token");
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getMe`,
        { signal: AbortSignal.timeout(10_000) },
      );
      return (await res.json()) as { ok?: boolean };
    },
    notify: sendTelegramNotification,
    log,
  };

  if (!deps && !BOT_TOKEN) return;

  const now = (d.now ?? Date.now)();
  let ok: boolean;

  try {
    const data = await d.fetchGetMe();
    ok = data.ok === true;
  } catch {
    ok = false;
  }

  const result = processHealthResult(ok, now);

  if (result.notify === "down") {
    d.log("Telegram API down — sending down notification");
    await d.notify("⚠️ Telegram API connection lost — message delivery may be interrupted.");
  } else if (result.notify === "recovery") {
    d.log("Telegram bot recovered — sending recovery notification");
    await d.notify("⚡ Telegram connection restored — some messages may have been missed.");
  }
}

/** Best-effort Telegram notification for watchdog alerts.
 *  When a dedupKey is provided, delegates to packages/butler-agent/scripts/lib/notify-guard.sh so
 *  overlapping alerts (e.g. watchdog's MCP-down vs start-butler.sh's crash
 *  message) collapse to a single Telegram message. */
async function sendTelegramNotification(
  text: string,
  dedupKey?: string,
  ttlSecs: number = 30,
): Promise<void> {
  if (!BOT_TOKEN) return;

  if (dedupKey) {
    const guard = butlerAgentScriptPath(BUTLER_HOME, "lib", "notify-guard.sh");
    if (existsSync(guard)) {
      try {
        const proc = Bun.spawn(
          [
            "bash",
            "-c",
            `source "${guard}" && notify_once "$1" "$2" "$3"`,
            "notify_once",
            dedupKey,
            String(ttlSecs),
            text,
          ],
          {
            env: { ...process.env, BUTLER_HOME, BUTLER_DATA },
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        await proc.exited;
        return;
      } catch (err: any) {
        log(`notify-guard spawn failed, falling back to direct send: ${err.message}`);
      }
    }
  }

  // Read chat_id from config
  const configPath = join(BUTLER_HOME, "data", "butler.config.json");
  let chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!chatId) {
    try {
      const config = JSON.parse(
        readFileSync(configPath, "utf8"),
      );
      chatId = config?.telegram?.groupId || "";
    } catch {}
  }
  if (!chatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as { ok?: boolean; description?: string };
    if (!data.ok) {
      log(`Telegram sendMessage not ok: ${data.description ?? "unknown error"}`);
    }
  } catch (err: any) {
    log(`Failed to send Telegram notification: ${err.message}`);
  }
}

// ── Check 4: Agent-browser daemon cleanup ────────────────────────────────────

async function checkAgentBrowserDaemons(): Promise<number> {
  let actions = 0;

  let pgrepResult: { stdout: Buffer };
  try {
    pgrepResult = await $`pgrep -f "agent-browser.*daemon"`.quiet().nothrow() as any;
  } catch {
    return 0;
  }

  const pids = pgrepResult.stdout
    .toString()
    .trim()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  for (const pid of pids) {
    try {
      const elapsedResult = await $`ps -o etimes= -p ${pid}`.quiet().nothrow() as any;
      const elapsed = parseInt(elapsedResult.stdout.toString().trim(), 10);
      if (isNaN(elapsed) || elapsed <= BROWSER_DAEMON_MAX_SECS) continue;

      process.kill(pid, "SIGKILL");
      log(`Killed agent-browser daemon PID ${pid} (elapsed ${elapsed}s)`);
      actions++;
    } catch {}
  }

  return actions;
}

// ── Check 5: Orchestrator native-main liveness ───────────────────────────────

/**
 * checkOrchestratorLiveness — verifies the native butler-main process is alive.
 *
 * If the native main pid is missing, we call start-butler.sh directly so
 * recovery works even when no external process manager is installed.
 */
async function checkOrchestratorLiveness(): Promise<void> {
  const nativeState = readNativeMainState(getNativeMainStatePath(BUTLER_DATA));
  if (nativeState && isPidRunning(nativeState.pid)) return;

  const service = listServices({ butlerHome: BUTLER_HOME, butlerData: BUTLER_DATA })
    .find((item) => item.serviceId === "butler-main");
  if (service?.status === "online") return;

  // Native service liveness below owns restart decisions. This check only
  // preserves the older native-main-state signal without spawning a parallel
  // start-butler.sh instance during service startup.
  log(`Native butler-main process pointer missing; service status is ${service?.status ?? "unknown"}`);
}

// ── Check 5b: Native service liveness ────────────────────────────────────────

async function checkNativeServiceLiveness(): Promise<number> {
  const shutdownFlag = join(BUTLER_DATA, "locks", "butler-shutdown");
  if (existsSync(shutdownFlag)) return 0;

  let actions = 0;
  const specs = defaultNativeServiceSpecs({ butlerHome: BUTLER_HOME, butlerData: BUTLER_DATA });
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  for (const service of listServices({ butlerHome: BUTLER_HOME, butlerData: BUTLER_DATA })) {
    if (service.serviceId === "butler-watchdog") continue;
    if (service.status === "online") continue;
    const spec = byId.get(service.serviceId);
    if (!spec || spec.restartPolicy !== "watchdog") continue;
    try {
      const restarted = startService(BUTLER_DATA, spec);
      log(`Restarted native service ${service.serviceId} (status was ${service.status}, pid=${restarted.pid ?? "unknown"})`);
      actions += 1;
    } catch (error) {
      log(`Failed to restart native service ${service.serviceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return actions;
}

// ── Check 6: MCP server liveness ─────────────────────────────────────────────

interface McpHealthState {
  healthy: boolean;
  since: string; // ISO timestamp
}

function readMcpHealthState(): McpHealthState | null {
  try {
    return JSON.parse(readFileSync(MCP_HEALTH_STATE_FILE, "utf8")) as McpHealthState;
  } catch {
    return null;
  }
}

function writeMcpHealthState(state: McpHealthState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MCP_HEALTH_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

/**
 * checkMcpLiveness — alerts when MCP server is dead but butler-main is alive.
 *
 * Uses a state machine persisted to data/state/watchdog-mcp-health.json to
 * send Telegram alerts only on health-state TRANSITIONS:
 *   healthy → down:    send 🛑 alert once
 *   down → healthy:    send ✅ recovery once
 *   no transition:     silent
 *
 * We deliberately do NOT auto-restart — the alert is enough.
 */
async function checkMcpLiveness(): Promise<void> {
  const nativeState = readNativeMainState(getNativeMainStatePath(BUTLER_DATA));
  if (!nativeState || !isPidRunning(nativeState.pid)) return;

  // Butler main process is alive. Check if MCP server process is running.
  const mcpResult = await $`pgrep -f "packages/butler-agent/src/interfaces/mcp-server/server"`.quiet().nothrow() as any;
  const currentlyHealthy = mcpResult.stdout.toString().trim().length > 0;

  const prevState = readMcpHealthState();
  const now = new Date();
  const nowIso = now.toISOString();

  if (prevState === null) {
    // First run — initialize state, no alert
    writeMcpHealthState({ healthy: currentlyHealthy, since: nowIso });
    return;
  }

  if (prevState.healthy === currentlyHealthy) {
    // No state transition — stay silent
    return;
  }

  // State transition detected
  const durationMs = now.getTime() - new Date(prevState.since).getTime();
  const durationMin = Math.round(durationMs / 60000);

  writeMcpHealthState({ healthy: currentlyHealthy, since: nowIso });

  if (!currentlyHealthy) {
    // healthy → down
    log("MCP server process not found while butler-main is alive — sending down alert");
    await sendTelegramNotification(
      "🛑 MCP server is down. Tool access may be broken. Manual restart recommended: butler restart",
      "butler-main-crash",
      30,
    );
  } else {
    // down → healthy (recovered)
    log(`MCP server recovered after ${durationMin}m — sending recovery alert`);
    await sendTelegramNotification(
      `✅ MCP server recovered (was down for ${durationMin}m).`,
      "butler-main-recovery",
      30,
    );
  }
}

// ── Check 8: Duplicate MCP server instances ──────────────────────────────────

async function checkDuplicateMcpServers(): Promise<number> {
  let actions = 0;

  let pgrepResult: { stdout: Buffer };
  try {
    pgrepResult = await $`pgrep -f "bun.*packages/butler-agent/src/interfaces/mcp-server/server"`.quiet().nothrow() as any;
  } catch {
    return 0;
  }

  const pids = pgrepResult.stdout
    .toString()
    .trim()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  if (pids.length === 0) return 0;

  // Each MCP server belongs to its parent host process. Multiple
  // Butler processes legitimately each have their own MCP via stdio. Only
  // reap orphans whose parent is dead — never kill an MCP whose parent is
  // alive, even if it looks like a "duplicate".
  for (const pid of pids) {
    try {
      const ppidResult = await $`ps -o ppid= -p ${pid}`.quiet().nothrow() as any;
      const ppid = parseInt(ppidResult.stdout.toString().trim(), 10);
      if (isNaN(ppid) || ppid <= 1) continue;
      try {
        process.kill(ppid, 0);
        // parent alive — leave it alone
      } catch {
        // parent dead — orphan, reap it
        try {
          process.kill(pid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 1000));
          try { process.kill(pid, "SIGKILL"); } catch {}
          log(`Reaped orphan MCP server PID ${pid} (parent ${ppid} is dead)`);
          actions++;
        } catch {}
      }
    } catch {}
  }

  return actions;
}

// ── Main cycle ────────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  let totalActions = 0;

  // 1. Dead worker cleanup
  try {
    const n = await checkDeadWorkers(TASKS_DIR, productionDeps);
    totalActions += n;
  } catch (err: any) {
    log(`checkDeadWorkers error: ${err.message}`);
  }

  // 2. Worker timeout enforcement
  try {
    const threshold = calcTimeoutSecs(WORKER_TIMEOUT_SEC);
    const n = await checkWorkerTimeouts(threshold);
    totalActions += n;
  } catch (err: any) {
    log(`checkWorkerTimeouts error: ${err.message}`);
  }

  // 3. Telegram polling health
  try {
    await checkTelegramHealth();
  } catch (err: any) {
    log(`checkTelegramHealth error: ${err.message}`);
  }

  // 4. Agent-browser daemon cleanup
  try {
    const n = await checkAgentBrowserDaemons();
    totalActions += n;
  } catch (err: any) {
    log(`checkAgentBrowserDaemons error: ${err.message}`);
  }

  if (!SERVICE_LIVENESS_DISABLED) {
    // 5. Orchestrator native-main liveness
    try {
      await checkOrchestratorLiveness();
    } catch (err: any) {
      log(`checkOrchestratorLiveness error: ${err.message}`);
    }

    // 5b. Native service liveness for watchdog-owned services
    try {
      const n = await checkNativeServiceLiveness();
      totalActions += n;
    } catch (err: any) {
      log(`checkNativeServiceLiveness error: ${err.message}`);
    }
  }

  // 6. MCP server liveness
  try {
    await checkMcpLiveness();
  } catch (err: any) {
    log(`checkMcpLiveness error: ${err.message}`);
  }

  // 7. Duplicate MCP server cleanup
  try {
    const n = await checkDuplicateMcpServers();
    totalActions += n;
  } catch (err: any) {
    log(`checkDuplicateMcpServers error: ${err.message}`);
  }

  // 8. Steward subsession liveness
  try {
    await checkStewardLiveness();
  } catch (err: any) {
    log(`checkStewardLiveness error: ${err.message}`);
  }

  // 9. Butler-main local transcript api_error detection
  try {
    await checkButlerMainApi();
  } catch (err: any) {
    log(`checkButlerMainApi error: ${err.message}`);
  }

  if (totalActions > 0) {
    log(`Watchdog cycle complete — ${totalActions} action(s) taken`);
  } else {
    log("Watchdog cycle complete — no issues found");
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Singleton guard: refuse to start if another watchdog is already running.
// If an older launch leaves PPID=1 orphans, two watchdogs can coexist and
// duplicate every alert. Refuse to start when a live parent already owns one.
async function ensureSingleton(): Promise<void> {
  let pgrepResult: { stdout: Buffer };
  try {
    pgrepResult = await $`pgrep -f "bun.*watchdog\\.ts"`.quiet().nothrow() as any;
  } catch {
    return;
  }
  const pids = pgrepResult.stdout
    .toString()
    .trim()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0 && n !== process.pid);
  if (pids.length === 0) return;

  log(`Singleton guard: another watchdog already running (PIDs: ${pids.join(", ")}). Reaping orphans then yielding to a live parent if present.`);

  const nativeWatchdog = readServiceState(BUTLER_DATA, "butler-watchdog");
  if (
    nativeWatchdog &&
    pids.includes(nativeWatchdog.pid) &&
    isPidRunning(nativeWatchdog.pid)
  ) {
    log(`Singleton guard: native-supervisor watchdog PID ${nativeWatchdog.pid} is already running — yielding, exiting self.`);
    process.exit(0);
  }

  let reapedAny = false;
  for (const pid of pids) {
    try {
      const ppidResult = await $`ps -o ppid= -p ${pid}`.quiet().nothrow() as any;
      const ppid = parseInt(ppidResult.stdout.toString().trim(), 10);
      if (!isNaN(ppid) && ppid <= 1) {
        try {
          process.kill(pid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 1000));
          try { process.kill(pid, "SIGKILL"); } catch {}
          log(`Singleton guard: reaped orphan watchdog PID ${pid} (PPID=${ppid})`);
          reapedAny = true;
        } catch {}
      } else {
        log(`Singleton guard: another watchdog PID ${pid} has live parent ${ppid} — yielding, exiting self.`);
        process.exit(0);
      }
    } catch {}
  }
  if (reapedAny) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (import.meta.main) {
  if (!SINGLETON_DISABLED) await ensureSingleton();
  log("Butler watchdog starting");
  runCycle().catch((err) => log(`Cycle error: ${err.message}`));
  setInterval(() => {
    runCycle().catch((err) => log(`Cycle error: ${err.message}`));
  }, INTERVAL_MS);
}
