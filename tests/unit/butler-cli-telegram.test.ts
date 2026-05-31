import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildTelegramCliStatus, pairTelegramChat } from "../../packages/butler-agent/src/interfaces/cli/telegram.ts";

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-cli-telegram-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("Telegram CLI status reads private env without returning token contents", () => {
  const butlerData = tempRoot();

  try {
    writeFileSync(join(butlerData, ".env"), [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_CHAT_ID=987",
      "",
    ].join("\n"));

    expect(buildTelegramCliStatus(butlerData)).toEqual({
      tokenConfigured: true,
      chatPaired: true,
      chatId: "987",
      envPath: join(butlerData, ".env"),
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Telegram CLI pairing persists chat id from Bot API updates", async () => {
  const butlerData = tempRoot();
  const requests: string[] = [];

  try {
    const result = await pairTelegramChat({
      butlerData,
      token: "123:secret",
      apiBase: "https://telegram.test",
      pollIntervalMs: 0,
      timeoutMs: 100,
      now: () => 1_700_000_000_000,
      fetcher: async (url: URL) => {
        requests.push(url.toString());
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 10,
            message: {
              chat: {
                id: 54321,
              },
            },
          }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(result.chatId).toBe("54321");
    expect(result.tokenConfigured).toBe(true);
    expect(result.chatPaired).toBe(true);
    expect(requests[0]).toContain("https://telegram.test/bot123:secret/getUpdates");

    const env = readFileSync(join(butlerData, ".env"), "utf8");
    expect(env).toContain("TELEGRAM_CHAT_ID=\"54321\"");
    expect(env).toContain("TELEGRAM_BOT_TOKEN=\"123:secret\"");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Telegram CLI pairing redacts token from provider errors", async () => {
  const butlerData = tempRoot();

  try {
    await expect(pairTelegramChat({
      butlerData,
      token: "123:secret",
      apiBase: "https://telegram.test",
      pollIntervalMs: 0,
      timeoutMs: 100,
      now: () => 1_700_000_000_000,
      fetcher: async () => new Response(JSON.stringify({
        ok: false,
        description: "bad token 123:secret",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })).rejects.toThrow("bad token [redacted-telegram-token]");

    await expect(pairTelegramChat({
      butlerData,
      token: "123:secret",
      apiBase: "https://telegram.test",
      pollIntervalMs: 0,
      timeoutMs: 100,
      now: () => 1_700_000_000_000,
      fetcher: async () => {
        throw new Error("fetch failed for https://telegram.test/bot123:secret/getUpdates");
      },
    })).rejects.toThrow("bot[redacted-telegram-token]/getUpdates");

    await expect(pairTelegramChat({
      butlerData,
      token: "123:secret",
      apiBase: "https://telegram.test",
      pollIntervalMs: 0,
      timeoutMs: 100,
      now: () => 1_700_000_000_000,
      fetcher: async () => new Response("bad token 123:secret", { status: 401 }),
    })).rejects.toThrow("bad token [redacted-telegram-token]");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
