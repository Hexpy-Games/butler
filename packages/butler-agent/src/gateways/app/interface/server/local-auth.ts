import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CreateAppServerOptions } from "./server-types.ts";
import { RequestError } from "./responses.ts";
import { isStaticUiRequest } from "./static-ui.ts";

export interface LocalAuthConfig {
  required: boolean;
  token: string | null;
}

/** Read the same file-backed bearer authority used by the App gateway. */
export function readLocalAuthConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): LocalAuthConfig {
  if (env.BUTLER_APP_LOCAL_AUTH_REQUIRED !== "1") {
    return { required: false, token: null };
  }
  return readLocalAuthConfigFromFile(env.BUTLER_APP_LOCAL_AUTH_FILE);
}

export function readLocalAuthConfigFromFile(
  path: string | undefined,
): LocalAuthConfig {
  const filePath = typeof path === "string" && path.trim() ? path.trim() : "";
  if (!filePath) return { required: true, token: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      token?: unknown;
    };
    return {
      required: true,
      token: typeof parsed.token === "string" && parsed.token.trim()
        ? parsed.token.trim()
        : null,
    };
  } catch {
    return { required: true, token: null };
  }
}

export function normalizeLocalAuth(
  input: CreateAppServerOptions["localAuth"],
): LocalAuthConfig {
  return {
    required: input?.required === true,
    token: safeString(input?.token) ?? null,
  };
}

export function enforceLocalAuth(
  request: Request,
  localAuth: LocalAuthConfig,
): void {
  if (!localAuth.required) return;
  if (isStaticUiRequest(request)) return;
  if (!localAuth.token) {
    throw new RequestError(
      503,
      "local_auth_unconfigured",
      "Butler App local auth is not configured.",
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  if (!match || !constantTimeTokenEqual(match[1] ?? "", localAuth.token)) {
    throw new RequestError(
      401,
      "local_auth_required",
      "Butler App local auth is required.",
    );
  }
}

function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
