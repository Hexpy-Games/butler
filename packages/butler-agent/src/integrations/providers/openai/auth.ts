import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type OpenAIAuthMode = "api_key" | "codex_subscription" | "codex_oauth";

export interface ButlerOpenAIAuthProfile {
  provider: "openai-codex";
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  email?: string;
  scope?: string;
  provenance: "codex-subscription-oauth";
  updatedAt: string;
}

export interface OpenAIAuthResolution {
  mode: OpenAIAuthMode;
  envKey: "OPENAI_API_KEY" | "BUTLER_CODEX_AUTH_PROFILE" | "CODEX_AUTH_JSON";
  authorization: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    id_token?: string;
  };
}

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function getButlerOpenAIAuthProfilePath(): string {
  return process.env.BUTLER_CODEX_AUTH_PROFILE ||
    process.env.BUTLER_OPENAI_AUTH_PROFILE ||
    join(getButlerData(), "auth", "openai-codex.json");
}

function getCodexAuthPath(): string {
  return process.env.CODEX_AUTH_JSON || join(getCodexHome(), "auth.json");
}

export function readButlerOpenAIAuthProfile(): ButlerOpenAIAuthProfile | null {
  const path = getButlerOpenAIAuthProfilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.type === "oauth" && typeof parsed.accessToken === "string") {
      return parsed as ButlerOpenAIAuthProfile;
    }
  } catch {}
  return null;
}

export function writeButlerOpenAIAuthProfile(profile: ButlerOpenAIAuthProfile): void {
  const path = getButlerOpenAIAuthProfilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
}

function readCodexAuthFile(): CodexAuthFile | null {
  const path = getCodexAuthPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CodexAuthFile;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function accountIdFromAccessToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object" && "chatgpt_account_id" in auth) {
    const value = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof value === "string" ? value : undefined;
  }
  if (auth && typeof auth === "object" && "account_id" in auth) {
    const value = (auth as Record<string, unknown>).account_id;
    return typeof value === "string" ? value : undefined;
  }
  return typeof payload?.sub === "string" ? payload.sub : undefined;
}

export function emailFromAccessToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  return typeof payload?.email === "string" ? payload.email : undefined;
}

function isExpiring(profile: ButlerOpenAIAuthProfile): boolean {
  if (!profile.expiresAt) return false;
  return Date.now() > profile.expiresAt - 60_000;
}

function getTokenUrl(): string {
  return process.env.BUTLER_CODEX_OAUTH_TOKEN_URL ||
    process.env.BUTLER_OPENAI_OAUTH_TOKEN_URL ||
    "https://auth.openai.com/oauth/token";
}

export function getOpenAIOAuthClientId(): string {
  return process.env.BUTLER_CODEX_OAUTH_CLIENT_ID?.trim() ||
    process.env.BUTLER_OPENAI_OAUTH_CLIENT_ID?.trim() ||
    "app_EMoamEEZ73f0CkXaXp7hrann";
}

export function getOpenAIOAuthScope(): string {
  return process.env.BUTLER_CODEX_OAUTH_SCOPE?.trim() ||
    process.env.BUTLER_OPENAI_OAUTH_SCOPE?.trim() ||
    "openid profile email offline_access";
}

export function getOpenAIOAuthOriginator(): string | undefined {
  return process.env.BUTLER_CODEX_OAUTH_ORIGINATOR?.trim() ||
    process.env.BUTLER_OPENAI_OAUTH_ORIGINATOR?.trim() ||
    "butler";
}

export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildOpenAIAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(
    process.env.BUTLER_CODEX_OAUTH_AUTHORIZE_URL ||
      process.env.BUTLER_OPENAI_OAUTH_AUTHORIZE_URL ||
      "https://auth.openai.com/oauth/authorize",
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope || getOpenAIOAuthScope());
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  const originator = getOpenAIOAuthOriginator();
  if (originator) {
    url.searchParams.set("originator", originator);
  }
  return url.toString();
}

export async function exchangeOpenAIOAuthCode(input: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ButlerOpenAIAuthProfile> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const response = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`OpenAI OAuth token exchange failed (${response.status}): ${await response.text()}`);
  }
  const token = await response.json() as Record<string, any>;
  const accessToken = String(token.access_token || "");
  if (!accessToken) throw new Error("OpenAI OAuth token exchange did not return an access token");
  const now = Date.now();
  return {
    provider: "openai-codex",
    type: "oauth",
    accessToken,
    refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
    expiresAt: typeof token.expires_in === "number" ? now + token.expires_in * 1000 : undefined,
    accountId: accountIdFromAccessToken(accessToken),
    email: emailFromAccessToken(accessToken),
    scope: typeof token.scope === "string" ? token.scope : undefined,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(now).toISOString(),
  };
}

export async function refreshButlerOpenAIAuthProfile(profile: ButlerOpenAIAuthProfile): Promise<ButlerOpenAIAuthProfile> {
  const clientId = getOpenAIOAuthClientId();
  if (!clientId || !profile.refreshToken) return profile;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: profile.refreshToken,
  });
  const response = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return profile;
  const token = await response.json() as Record<string, any>;
  const accessToken = typeof token.access_token === "string" ? token.access_token : profile.accessToken;
  const now = Date.now();
  const next: ButlerOpenAIAuthProfile = {
    ...profile,
    accessToken,
    refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : profile.refreshToken,
    expiresAt: typeof token.expires_in === "number" ? now + token.expires_in * 1000 : profile.expiresAt,
    accountId: accountIdFromAccessToken(accessToken) ?? profile.accountId,
    email: emailFromAccessToken(accessToken) ?? profile.email,
    scope: typeof token.scope === "string" ? token.scope : profile.scope,
    updatedAt: new Date(now).toISOString(),
  };
  writeButlerOpenAIAuthProfile(next);
  return next;
}

export async function resolveOpenAIAuth(): Promise<OpenAIAuthResolution> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return { mode: "api_key", envKey: "OPENAI_API_KEY", authorization: `Bearer ${apiKey}` };
  }

  return await resolveOpenAICodexAuth();
}

export async function resolveOpenAICodexAuth(): Promise<OpenAIAuthResolution> {
  const butlerProfile = readButlerOpenAIAuthProfile();
  if (butlerProfile?.accessToken) {
    const profile = isExpiring(butlerProfile) ? await refreshButlerOpenAIAuthProfile(butlerProfile) : butlerProfile;
    return { mode: "codex_subscription", envKey: "BUTLER_CODEX_AUTH_PROFILE", authorization: `Bearer ${profile.accessToken}` };
  }

  const codexAuth = readCodexAuthFile();
  const codexAccessToken = codexAuth?.tokens?.access_token?.trim();
  if (codexAccessToken) {
    return { mode: "codex_oauth", envKey: "CODEX_AUTH_JSON", authorization: `Bearer ${codexAccessToken}` };
  }

  throw new Error(
    "Codex subscription login is required for OpenAI Codex OAuth auth.",
  );
}
