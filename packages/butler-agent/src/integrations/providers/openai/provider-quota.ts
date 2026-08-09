import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  unavailableProviderQuota,
  type ProviderQuotaAdapter,
  type ProviderQuotaReason,
} from "../../../operations/metrics/provider-quota.ts";
import {
  CODEX_RATE_LIMIT_SOURCE,
  parseOpenAICodexRateLimits,
} from "./codex-rate-limits.ts";
import { getOpenAIAuthSummary } from "./control-plane.ts";
import {
  runCodexQuotaProcess,
  type CodexQuotaProcessRunner,
  type CodexQuotaProcessRequest,
  type CodexQuotaProcessResult,
} from "./codex-quota-process.ts";

export const CODEX_QUOTA_TIMEOUT_MS = 2_500;
export const CODEX_QUOTA_MAX_OUTPUT_BYTES = 64 * 1024;

export type {
  CodexQuotaProcessRequest,
  CodexQuotaProcessResult,
  CodexQuotaProcessRunner,
};

function defaultExecutable(): string | null {
  try {
    return typeof Bun.which === "function" ? Bun.which("codex") : null;
  } catch {
    return null;
  }
}

function canonicalCodexAuthPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
}

function normalizedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function codexAuthSurfaceMatches(): boolean {
  const configured = process.env.CODEX_AUTH_JSON?.trim();
  if (!configured) return true;
  return normalizedPath(configured) === normalizedPath(canonicalCodexAuthPath());
}

function unavailable(reason: ProviderQuotaReason) {
  return unavailableProviderQuota(reason, CODEX_RATE_LIMIT_SOURCE);
}

function rpcRequest(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function initializeInput(): string {
  return `${rpcRequest(1, "initialize", {
    clientInfo: { name: "butler", version: "provider-quota" },
    capabilities: { experimentalApi: false },
  })}\n`;
}

function followUpInput(): string {
  return [
    JSON.stringify({ method: "initialized" }),
    rpcRequest(2, "account/rateLimits/read"),
    "",
  ].join("\n");
}

export interface OpenAIQuotaAdapterOptions {
  executable?: string | null;
  resolveExecutable?: () => string | null;
  runProcess?: CodexQuotaProcessRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function createOpenAIQuotaAdapter(
  options: OpenAIQuotaAdapterOptions = {},
): ProviderQuotaAdapter {
  const runProcess = options.runProcess ?? runCodexQuotaProcess;
  const resolveExecutable = options.resolveExecutable ?? defaultExecutable;
  return {
    providerId: "openai",
    async read() {
      const authSummary = (() => {
        try {
          return getOpenAIAuthSummary();
        } catch {
          return null;
        }
      })();
      if (!authSummary) {
        return unavailable({
          code: "provider_auth_required",
          message: "OpenAI Codex subscription authentication is not configured.",
        });
      }
      if (authSummary.mode === "api_key") {
        return unavailable({
          code: "provider_auth_not_applicable",
          message: "OpenAI API-key authentication has no Codex subscription allowance.",
        });
      }
      if (!codexAuthSurfaceMatches()) {
        return unavailable({
          code: "provider_auth_surface_mismatch",
          message: "Codex quota requires the provider canonical auth.json surface.",
        });
      }
      if (process.env.BUTLER_CODEX_AUTH_PROFILE?.trim() ||
        process.env.BUTLER_OPENAI_AUTH_PROFILE?.trim() ||
        authSummary.envKey !== "CODEX_AUTH_JSON") {
        return unavailable({
          code: "provider_auth_surface_mismatch",
          message: "Codex quota requires the CODEX_AUTH_JSON authentication surface.",
        });
      }
      const executable = options.executable === undefined
        ? resolveExecutable()
        : options.executable;
      if (!executable) {
        return unavailable({
          code: "provider_executable_unavailable",
          message: "The compatible codex executable is unavailable.",
        });
      }
      const processResult = await runProcess({
        executable,
        arguments: ["app-server", "--stdio"],
        stdin: initializeInput(),
        followUpStdin: followUpInput(),
        timeoutMs: options.timeoutMs ?? CODEX_QUOTA_TIMEOUT_MS,
        maxOutputBytes: options.maxOutputBytes ?? CODEX_QUOTA_MAX_OUTPUT_BYTES,
      });
      if (processResult.timedOut) {
        return unavailable({
          code: "provider_timeout",
          message: "The OpenAI Codex quota read timed out.",
        });
      }
      if (processResult.spawnError) {
        return unavailable({
          code: "provider_executable_unavailable",
          message: "The compatible codex executable could not be started.",
        });
      }
      if (processResult.outputLimitExceeded) {
        return unavailable({
          code: "provider_response_malformed",
          message: "The OpenAI Codex quota response exceeded the safe size limit.",
        });
      }
      if (processResult.exitCode !== 0) {
        return unavailable({
          code: "provider_rpc_failure",
          message: "The OpenAI Codex quota service did not return a usable result.",
        });
      }
      const parsed = parseOpenAICodexRateLimits(processResult.stdout);
      if (parsed.kind === "ok") return parsed.result;
      return unavailable({
        code: parsed.kind === "auth"
          ? "provider_auth_failure"
          : parsed.kind === "rpc"
            ? "provider_rpc_failure"
            : "provider_response_malformed",
        message: parsed.kind === "auth"
          ? "OpenAI Codex authentication was rejected."
          : "The OpenAI Codex quota response was unavailable or malformed.",
      });
    },
  };
}
