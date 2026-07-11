#!/usr/bin/env bun
import { createServer } from "http";
import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import {
  buildOpenAIAuthorizeUrl,
  exchangeOpenAIOAuthCode,
  generatePkceVerifier,
  getOpenAIOAuthClientId,
  pkceChallenge,
  writeButlerOpenAIAuthProfile,
} from "../src/integrations/providers/openai/auth.ts";

type EnvLike = Record<string, string | undefined>;

export function resolveOAuthPort(env: EnvLike = process.env): number {
  return Number(env.BUTLER_CODEX_OAUTH_PORT || env.BUTLER_OPENAI_OAUTH_PORT || "1455");
}

export function resolveOAuthRedirectUri(port: number, env: EnvLike = process.env): string {
  return env.BUTLER_CODEX_OAUTH_REDIRECT_URI ||
    env.BUTLER_OPENAI_OAUTH_REDIRECT_URI ||
    `http://localhost:${port}/auth/callback`;
}

export function isContainerRuntime(fileExists: (path: string) => boolean = existsSync): boolean {
  return fileExists("/.dockerenv") || fileExists("/run/.containerenv");
}

export function resolveOAuthListenHost(env: EnvLike = process.env): string {
  return env.BUTLER_CODEX_OAUTH_LISTEN_HOST ||
    env.BUTLER_OPENAI_OAUTH_LISTEN_HOST ||
    (isContainerRuntime() ? "0.0.0.0" : "localhost");
}

export function shouldAttemptBrowserOpen(env: EnvLike = process.env, platform = process.platform): boolean {
  if (env.BUTLER_CODEX_OAUTH_NO_BROWSER === "1" || env.BUTLER_OPENAI_OAUTH_NO_BROWSER === "1") {
    return false;
  }
  if (platform !== "linux") {
    return true;
  }
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.WSL_DISTRO_NAME);
}

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
  }).status === 0;
}

function openBrowser(target: string): boolean {
  if (!shouldAttemptBrowserOpen()) {
    return false;
  }
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  if (!commandExists(command)) {
    return false;
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function main(): Promise<void> {
  const clientId = getOpenAIOAuthClientId();
  if (!clientId) {
    console.error("Codex subscription OAuth client id is not configured.");
    console.error("Set BUTLER_CODEX_OAUTH_CLIENT_ID only if you need to override Butler's bundled Codex OAuth client id.");
    process.exit(2);
  }

  const port = resolveOAuthPort();
  const redirectUri = resolveOAuthRedirectUri(port);
  const listenHost = resolveOAuthListenHost();
  const verifier = generatePkceVerifier();
  const state = randomBytes(16).toString("hex");
  const url = buildOpenAIAuthorizeUrl({
    clientId,
    redirectUri,
    codeChallenge: pkceChallenge(verifier),
    state,
  });

  console.log(url);
  console.log(`Waiting for callback on ${redirectUri}. Press Ctrl+C to cancel.`);
  if (listenHost === "0.0.0.0") {
    console.log(`Listening on 0.0.0.0:${port}; publish this port from Docker so your host browser can reach localhost:${port}.`);
  }

  const profile = await new Promise<Awaited<ReturnType<typeof exchangeOpenAIOAuthCode>>>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const current = new URL(req.url || "/", redirectUri);
        if (current.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const error = current.searchParams.get("error");
        if (error) throw new Error(error);
        const returnedState = current.searchParams.get("state");
        if (returnedState !== state) throw new Error("OAuth state mismatch");
        const code = current.searchParams.get("code");
        if (!code) throw new Error("OAuth callback did not include a code");
        const token = await exchangeOpenAIOAuthCode({
          clientId,
          code,
          redirectUri,
          codeVerifier: verifier,
        });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Codex subscription login complete. You can close this tab.");
        server.close();
        resolve(token);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Codex subscription login failed: ${err instanceof Error ? err.message : String(err)}`);
        server.close();
        reject(err);
      }
    });
    server.listen(port, listenHost, () => {
      if (openBrowser(url)) {
        console.log("Opening Codex subscription login in your browser.");
      } else {
        console.log("Could not open a browser automatically. Open the URL above to continue.");
      }
    });
    server.on("error", reject);
  });

  writeButlerOpenAIAuthProfile(profile);
  const label = profile.email || profile.accountId || "OpenAI account";
  console.log(`Codex subscription auth profile saved for ${label}.`);
}

if (import.meta.main) {
  await main();
}
