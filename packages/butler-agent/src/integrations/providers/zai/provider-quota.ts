import {
  defaultHostedProviderApiBaseUrl,
} from "../model-catalog.ts";
import {
  readRegisteredHostedModelConfigs,
  resolveProviderCredentialSecret,
} from "../shared/registered-models.ts";
import {
  unavailableProviderQuota,
  type ProviderQuotaAdapter,
  type ProviderQuotaResult,
} from "../../../operations/metrics/provider-quota.ts";
import {
  parseZaiQuotaResponse,
  ZAI_QUOTA_SOURCE,
} from "./zai-quota-response.ts";

export const ZAI_QUOTA_TIMEOUT_MS = 2_500;
export const ZAI_QUOTA_MAX_OUTPUT_BYTES = 64 * 1024;

interface ZaiQuotaAuth {
  token: string;
  quotaUrl: string;
}

export type ZaiQuotaFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

type ZaiQuotaRead =
  | { kind: "ok"; result: ProviderQuotaResult }
  | { kind: "auth" }
  | { kind: "unsupported" }
  | { kind: "timeout" }
  | { kind: "malformed" }
  | { kind: "temporary" };

export interface ZaiQuotaAdapterOptions {
  butlerData?: string;
  fetchImpl?: ZaiQuotaFetch;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function unavailable(code: Parameters<typeof unavailableProviderQuota>[0]["code"], message: string) {
  return unavailableProviderQuota({ code, message }, ZAI_QUOTA_SOURCE);
}

function codingPlanQuotaUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "api.z.ai" ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname.replace(/\/+$/u, "") !== "/api/coding/paas/v4"
    ) return null;
    return `${parsed.origin}/api/monitor/usage/quota/limit`;
  } catch {
    return null;
  }
}

function resolveZaiQuotaAuth(butlerData?: string):
  | { kind: "ok"; auth: ZaiQuotaAuth }
  | { kind: "required" }
  | { kind: "mismatch" } {
  let configs;
  try {
    configs = readRegisteredHostedModelConfigs(butlerData)
      .filter((config) => config.provider_id === "zai");
  } catch {
    return { kind: "required" };
  }
  if (configs.length === 0) return { kind: "required" };
  if (configs.some((config) => config.auth_type !== "api_key" || !config.credential_id)) {
    return { kind: "mismatch" };
  }
  const credentialIds = new Set(configs.map((config) => config.credential_id));
  if (credentialIds.size !== 1) return { kind: "mismatch" };
  const credentialId = configs[0]?.credential_id;
  if (!credentialId) return { kind: "required" };
  const token = resolveProviderCredentialSecret(credentialId, "zai", butlerData);
  if (!token) return { kind: "required" };
  const baseUrls = configs.map((config) =>
    codingPlanQuotaUrl(
      config.api_base_url ??
        process.env.BUTLER_ZAI_BASE_URL?.trim() ??
        defaultHostedProviderApiBaseUrl("zai") ??
        "",
    ),
  );
  if (baseUrls.some((url) => !url) || new Set(baseUrls).size !== 1) {
    return { kind: "mismatch" };
  }
  const quotaUrl = baseUrls[0];
  if (!quotaUrl) return { kind: "mismatch" };
  return { kind: "ok", auth: { token, quotaUrl } };
}

async function readQuotaEndpoint(
  auth: ZaiQuotaAuth,
  options: Required<Pick<ZaiQuotaAdapterOptions, "fetchImpl" | "timeoutMs" | "maxOutputBytes">>,
): Promise<ZaiQuotaRead> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const readBody = async (response: Response): Promise<
    | { kind: "ok"; body: string }
    | { kind: "limit" }
    | { kind: "temporary" }
  > => {
    if (!response.body) return { kind: "ok", body: "" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > options.maxOutputBytes) {
          return { kind: "limit" };
        }
        chunks.push(value);
      }
    } catch {
      return { kind: "temporary" };
    } finally {
      // Quota reads are diagnostic but can be refreshed frequently. Always
      // settle and detach the body reader, including normal EOF and a failed
      // provider stream, so the response cannot retain transport state.
      try {
        await reader.cancel();
      } catch {
        // Preserve the primary quota result.
      }
      try {
        reader.releaseLock();
      } catch {
        // The provider body may already have released its lock.
      }
    }
    return {
      kind: "ok",
      body: new TextDecoder().decode(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      ),
    };
  };
  const request = (async () => {
    const response = await options.fetchImpl(auth.quotaUrl, {
      method: "GET",
      headers: {
        Authorization: auth.token,
        "Accept-Language": "en-US,en",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      return { response, body: null };
    }
    return { response, body: await readBody(response) };
  })();
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("quota_timeout"));
    }, options.timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const { response, body } = await Promise.race([request, timeout]);
    if (!body) {
      if (response.status === 401 || response.status === 403) return { kind: "auth" };
      if (response.status === 404 || response.status === 405) return { kind: "unsupported" };
      return { kind: "temporary" };
    }
    if (body.kind === "limit") return { kind: "malformed" };
    if (body.kind === "temporary") return { kind: "temporary" };
    let payload: unknown;
    try {
      payload = JSON.parse(body.body);
    } catch {
      return { kind: "malformed" };
    }
    const parsed = parseZaiQuotaResponse(payload);
    if (parsed.kind === "ok") return parsed;
    return parsed;
  } catch {
    return { kind: timedOut ? "timeout" : "temporary" };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function createZaiQuotaAdapter(
  options: ZaiQuotaAdapterOptions = {},
): ProviderQuotaAdapter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? ZAI_QUOTA_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? ZAI_QUOTA_MAX_OUTPUT_BYTES;
  return {
    providerId: "zai",
    async read() {
      const eligibility = resolveZaiQuotaAuth(options.butlerData);
      if (eligibility.kind === "required") {
        return unavailable(
          "provider_auth_required",
          "Z.AI Coding Plan credentials are not configured.",
        );
      }
      if (eligibility.kind === "mismatch") {
        return unavailable(
          "provider_auth_surface_mismatch",
          "Z.AI Coding Plan credentials or endpoint are not eligible.",
        );
      }
      if (typeof fetchImpl !== "function") {
        return unavailable(
          "provider_temporary_failure",
          "The Z.AI quota transport is unavailable.",
        );
      }
      const outcome = await readQuotaEndpoint(eligibility.auth, {
        fetchImpl,
        timeoutMs,
        maxOutputBytes,
      });
      if (outcome.kind === "ok") return outcome.result;
      if (outcome.kind === "auth") {
        return unavailable(
          "provider_auth_failure",
          "Z.AI Coding Plan authentication was rejected.",
        );
      }
      if (outcome.kind === "unsupported") {
        return unavailable(
          "provider_quota_surface_unavailable",
          "The Z.AI quota surface is not available for this plan.",
        );
      }
      if (outcome.kind === "timeout") {
        return unavailable(
          "provider_timeout",
          "The Z.AI quota read timed out.",
        );
      }
      if (outcome.kind === "malformed") {
        return unavailable(
          "provider_response_malformed",
          "The Z.AI quota response was unavailable or malformed.",
        );
      }
      return unavailable(
        "provider_temporary_failure",
        "The Z.AI quota service is temporarily unavailable.",
      );
    },
  };
}
