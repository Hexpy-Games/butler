import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export type CloseoutJsonValidator =
  | "live-e2e"
  | "project-ledger-status"
  | "project-ledger-check";

export interface CloseoutCheck {
  name: string;
  cmd: string[];
  env?: Record<string, string>;
  parseJson?: boolean;
  validateJson?: CloseoutJsonValidator;
  expectedService?: string;
  expectedModel?: string;
  expectedReasoningEffort?: string;
  minLiveModelCalls?: number;
  timeoutMs?: number;
}

export interface CloseoutCheckResult {
  name: string;
  ok: true;
  durationMs: number;
  service: string | null;
  liveModelCalls: number;
}

export interface CloseoutConfig {
  model: `${string}/${string}`;
  reasoningEffort: "low" | "medium";
}

export interface SpawnSyncResultLike {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | null;
}

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
  },
) => SpawnSyncResultLike;

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const LIVE_TOKEN_RE = /\bLIVE_GNCC_[A-Z0-9_]+_[A-Za-z0-9._-]+\b/gu;
const SECRET_VALUE_RE = /\b(?:sk|pat|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}\b/gu;

export function normalizeCloseoutModel(value: string): `${string}/${string}` {
  const trimmed = value.trim();
  if (trimmed === "gpt-5.6-sol") return "openai/gpt-5.6-sol";
  if (trimmed.includes("/")) return trimmed as `${string}/${string}`;
  throw new Error(`GNCC closeout live E2E model must be provider/model, got ${value}`);
}

export function closeoutConfig(input: {
  model?: string;
  reasoningEffort?: string;
}): CloseoutConfig {
  const model = normalizeCloseoutModel(input.model || "openai/gpt-5.6-sol");
  const reasoningEffort = input.reasoningEffort || "low";
  assert(model === "openai/gpt-5.6-sol", `GNCC closeout live E2E must use GPT-5.6 Sol, got ${model}`);
  assert(
    reasoningEffort === "low" || reasoningEffort === "medium",
    `GNCC closeout reasoning must be low or medium, got ${reasoningEffort}`,
  );
  return { model, reasoningEffort };
}

export function ledgerChecks(input: {
  ledgerProject: string;
  projectLedgerBin: string;
  exists?: (path: string) => boolean;
}): CloseoutCheck[] {
  const exists = input.exists ?? existsSync;
  if (!exists(input.ledgerProject)) {
    throw new Error(`canonical Project Ledger project is required for GNCC closeout: ${input.ledgerProject}`);
  }
  const base = [
    "--project",
    input.ledgerProject,
    "--json",
  ];
  return [
    {
      name: "project-ledger-status",
      cmd: [input.projectLedgerBin, "status", ...base],
      parseJson: true,
      validateJson: "project-ledger-status",
      timeoutMs: 60_000,
    },
    {
      name: "project-ledger-check",
      cmd: [input.projectLedgerBin, "check", ...base],
      parseJson: true,
      validateJson: "project-ledger-check",
      timeoutMs: 60_000,
    },
  ];
}

export function runCloseoutCheck(
  check: CloseoutCheck,
  input: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    spawnSyncFn?: SpawnSyncLike;
    now?: () => number;
  } = {},
): CloseoutCheckResult {
  const startedAt = input.now?.() ?? Date.now();
  const [command, ...args] = check.cmd;
  if (!command) throw new Error(`${check.name} command is empty`);
  const result = (input.spawnSyncFn ?? defaultSpawnSync)(command, args, {
    cwd: input.cwd ?? process.cwd(),
    env: {
      ...(input.env ?? process.env),
      ...(check.env ?? {}),
    },
    encoding: "utf8",
    timeout: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
  });
  const stdout = outputText(result.stdout);
  const stderr = outputText(result.stderr);
  if (result.error) {
    throw new Error([
      `${check.name} failed before completion: ${redactProcessOutput(result.error.message)}`,
      tail(stdout),
      tail(stderr),
    ].filter(Boolean).join("\n"));
  }
  if (result.status !== 0) {
    throw new Error([
      `${check.name} failed with exit ${result.status ?? "null"}${result.signal ? ` signal ${result.signal}` : ""}`,
      tail(stdout),
      tail(stderr),
    ].filter(Boolean).join("\n"));
  }
  const parsed = check.parseJson ? parseTrailingJson(stdout) : null;
  if (parsed && check.validateJson) {
    validateCloseoutJson(check.validateJson, parsed, {
      service: check.expectedService,
      model: check.expectedModel,
      reasoningEffort: check.expectedReasoningEffort,
      minLiveModelCalls: check.minLiveModelCalls,
    });
  }
  return {
    name: check.name,
    ok: true,
    durationMs: (input.now?.() ?? Date.now()) - startedAt,
    service: typeof parsed?.service === "string" ? parsed.service : null,
    liveModelCalls: numberField(parsed, "liveModelCalls"),
  };
}

export function parseTrailingJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trimEnd();
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    const candidate = trimmed.slice(index).trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error("expected trailing JSON object in closeout subprocess output");
}

export function validateCloseoutJson(
  kind: CloseoutJsonValidator,
  parsed: Record<string, unknown>,
  expectation: {
    service?: string;
    model?: string;
    reasoningEffort?: string;
    minLiveModelCalls?: number;
  } = {},
): void {
  if (kind === "live-e2e") {
    assert(parsed.ok === true, `live E2E reported failure: ${diagnosticJson(parsed)}`);
    assert(
      numberField(parsed, "liveModelCalls") >= (expectation.minLiveModelCalls ?? 1),
      `live E2E did not report enough live model calls: ${diagnosticJson(parsed)}`,
    );
    if (expectation.service) {
      assert(parsed.service === expectation.service, `live E2E service mismatch: ${diagnosticJson(parsed)}`);
    }
    if (expectation.model) {
      assert(parsed.model === expectation.model, `live E2E model mismatch: ${diagnosticJson(parsed)}`);
    }
    if (expectation.reasoningEffort) {
      assert(
        parsed.reasoningEffort === expectation.reasoningEffort,
        `live E2E reasoning mismatch: ${diagnosticJson(parsed)}`,
      );
    }
    return;
  }
  if (kind === "project-ledger-status") {
    assert(parsed.ok === true, `Project Ledger status command failed: ${diagnosticJson(parsed)}`);
    const data = recordField(parsed, "data");
    assert(numberField(data, "issueCount") === 0, `Project Ledger status has issues: ${diagnosticJson(parsed)}`);
    assert(Array.isArray(data?.staleViews) && data.staleViews.length === 0, `Project Ledger status has stale views: ${diagnosticJson(parsed)}`);
    const index = recordField(data, "index");
    assert(index?.stale === false, `Project Ledger index is stale: ${diagnosticJson(parsed)}`);
    return;
  }
  assert(parsed.ok === true, `Project Ledger check command failed: ${diagnosticJson(parsed)}`);
  const data = recordField(parsed, "data");
  assert(data?.ok === true, `Project Ledger check data failed: ${diagnosticJson(parsed)}`);
  assert(numberField(data, "issueCount") === 0, `Project Ledger check has issues: ${diagnosticJson(parsed)}`);
}

export function numberField(value: Record<string, unknown> | null | undefined, key: string): number {
  const raw = value?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

export function tail(text: string): string {
  const trimmed = redactProcessOutput(text).trim();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-40).join("\n");
}

function defaultSpawnSync(
  command: string,
  args: string[],
  options: Parameters<SpawnSyncLike>[2],
): SpawnSyncResultLike {
  return spawnSync(command, args, options);
}

function outputText(value: string | Buffer | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function recordField(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const raw = value?.[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function diagnosticJson(value: Record<string, unknown>): string {
  return redactProcessOutput(JSON.stringify(value));
}

function redactProcessOutput(text: string): string {
  const home = homedir();
  return text
    .replaceAll(home, "~")
    .replace(LIVE_TOKEN_RE, "[redacted-live-token]")
    .replace(SECRET_VALUE_RE, "[redacted-secret]");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
