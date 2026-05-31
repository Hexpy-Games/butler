/**
 * watchdog-e2e-harness.ts — Thin harness for e2e testing checkTelegramHealth.
 *
 * Runs a single health check cycle against MOCK_API_URL, using the real
 * checkTelegramHealth function with injected deps pointing at the mock.
 *
 * Environment:
 *   MOCK_API_URL      — base URL of the controllable mock (e.g. http://mock-telegram:8443)
 *   TELEGRAM_BOT_TOKEN — bot token (any value; mock doesn't validate)
 *   TELEGRAM_CHAT_ID   — chat ID for notifications
 */

import { checkTelegramHealth, type TelegramHealthDeps } from "./watchdog.ts";

const MOCK_API_URL = process.env.MOCK_API_URL || "http://mock-telegram:8443";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test_token_12345";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "-1001234567890";

const deps: TelegramHealthDeps = {
  async fetchGetMe() {
    const res = await fetch(`${MOCK_API_URL}/bot${BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    });
    return (await res.json()) as { ok?: boolean };
  },

  async notify(text: string) {
    await fetch(`${MOCK_API_URL}/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
      signal: AbortSignal.timeout(5_000),
    });
  },

  log(msg: string) {
    // stderr so it doesn't interfere with test output parsing
    process.stderr.write(`[e2e-harness] ${msg}\n`);
  },
};

await checkTelegramHealth(deps);
