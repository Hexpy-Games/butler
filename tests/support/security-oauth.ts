import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "./native-app-server";

export const oauthAccountName = "account@example.com";

/** A private, offline authority and a real native gateway holding fake credentials. */
export async function createOauthSmokeServer(language: string, revokeStatus: number) {
  let revocations = 0;
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const authority = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration") return Response.json({
        issuer: url.origin, authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`, revocation_endpoint: `${url.origin}/revoke`,
        jwks_uri: `${url.origin}/jwks`,
      });
      if (url.pathname === "/jwks") return Response.json({ keys: [] });
      if (url.pathname === "/revoke" && request.method === "POST") {
        // Inspect only the shape; never retain or print the submitted token.
        const form = new URLSearchParams(await request.text());
        if (!form.get("token") || !form.get("client_id")) return new Response(null, { status: 400 });
        revocations++;
        await pending;
        return new Response(null, { status: revokeStatus });
      }
      if (url.pathname === "/v1/models") return Response.json({ data: [] });
      return new Response(null, { status: 404 });
    },
  });
  const scratch = mkdtempSync(join(tmpdir(), "butler-oauth-smoke-"));
  const butlerData = join(scratch, "data");
  const registration = join(butlerData, "auth/chatgpt.json");
  mkdirSync(join(butlerData, "auth"), { recursive: true });
  writeFileSync(registration, JSON.stringify({
    schema_version: 1, issuer: authority.url.origin, client_id: "offline-smoke-client",
    subject: "offline-smoke-subject", email: oauthAccountName, token_type: "Bearer",
    access_token: "fake-access", refresh_token: "fake-refresh", expires_at: Date.now() + 3_600_000,
    signed_in_at: "2026-10-20T03:00:00Z", scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
    plan_notice_acknowledged_at: new Date().toISOString(),
  }), { mode: 0o600 });
  try {
    const server = await createNativeAppServer({
      butlerData, uiRoot: resolve("packages/butler-app/client/ui/dist"),
      config: { user: { name: "Smoke", language } },
      env: { BUTLER_CHATGPT_AUTH_ISSUER: authority.url.origin, BUTLER_CHATGPT_API_BASE_URL: authority.url.origin },
    });
    const { secret } = JSON.parse(readFileSync(join(butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
    const adminHeaders = { ...server.authHeaders, "x-butler-admin": secret };
    return {
      server, adminHeaders, registration,
      revocations: () => revocations,
      holdRevocation() { pending = new Promise<void>((done) => { release = done; }); },
      releaseRevocation() { release?.(); pending = undefined; },
      redact(message: string) { return message.replaceAll(secret, "[redacted]").replaceAll(server.token, "[redacted]"); },
      async stop() {
        release?.();
        try { await server.stop(); }
        finally { await authority.stop(true); rmSync(scratch, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await authority.stop(true);
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
