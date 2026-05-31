import { afterEach, expect, test } from "bun:test";
import type { TelegramSendRequest } from "../../packages/butler-agent/src/interfaces/transport/telegram/api.ts";
import { createTelegramTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/telegram/adapter.ts";
import { toTelegramMarkdownV2 } from "../../packages/butler-agent/src/interfaces/transport/telegram/markdown-v2.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("telegram adapter renders principal decision events as inline callback buttons", async () => {
  const sent: TelegramSendRequest[] = [];
  const adapter = createTelegramTransportAdapter({
    sendTelegram: async (input) => {
      sent.push(input);
      return { ok: true, transportMessageId: "1" };
    },
  });

  await adapter.send({
    actionId: "decision:dec-1",
    transport: "telegram",
    accountId: "default",
    peer: { kind: "dm", id: "123" },
    message: { text: "A critical decision is needed." },
    metadata: {
      type: "principal_decision_requested",
      replyMarkup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: "pd:dec-1:approve" },
          { text: "Skip", callback_data: "pd:dec-1:skip" },
        ]],
      },
    },
  });

  expect(sent).toEqual([expect.objectContaining({
    chatId: "123",
    text: "A critical decision is needed\\.",
    parseMode: "MarkdownV2",
    replyMarkup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: "pd:dec-1:approve" },
        { text: "Skip", callback_data: "pd:dec-1:skip" },
      ]],
    },
  })]);
});

test("telegram adapter converts outbound documents to MarkdownV2 before Bot API delivery", async () => {
  const sent: TelegramSendRequest[] = [];
  const adapter = createTelegramTransportAdapter({
    sendTelegram: async (input) => {
      sent.push(input);
      return { ok: true, transportMessageId: "1" };
    },
  });

  await adapter.send({
    actionId: "markdown-doc",
    transport: "telegram",
    accountId: "default",
    peer: { kind: "dm", id: "123" },
    message: {
      text: [
        "# 조사 결과",
        "",
        "- **상태**: 완료.",
        "- 참고: [문서](https://example.com/docs).",
        "- 실행: `bun run check`",
      ].join("\n"),
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    chatId: "123",
    parseMode: "MarkdownV2",
  });
  expect(sent[0]!.text).toContain("*조사 결과*");
  expect(sent[0]!.text).toContain("•   *상태*: 완료\\.");
  expect(sent[0]!.text).toContain("[문서](https://example.com/docs)\\.");
  expect(sent[0]!.text).toContain("`bun run check`");
});

test("telegram adapter repairs MarkdownV2 reserved characters in table-heavy reports", async () => {
  const sent: TelegramSendRequest[] = [];
  const adapter = createTelegramTransportAdapter({
    sendTelegram: async (input) => {
      sent.push(input);
      return { ok: true, transportMessageId: "1" };
    },
  });

  await adapter.send({
    actionId: "reserved-character-report",
    transport: "telegram",
    accountId: "default",
    peer: { kind: "dm", id: "123" },
    message: {
      text: [
        "| 항목 | 평가 |",
        "|---|---|",
        "| 선거 구도 | 보수 시정 안정 계승+세대교체 |",
        "| 기술 | C++ / A+B=2 / OPEC+ |",
        "",
        "- 검증 포인트: R&D, 20+년, A-B, {정책}.",
      ].join("\n"),
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    chatId: "123",
    parseMode: "MarkdownV2",
  });
  expect(sent[0]!.text).toContain("계승\\+세대교체");
  expect(sent[0]!.text).toContain("C\\+\\+ / A\\+B\\=2 / OPEC\\+");
  expect(sent[0]!.text).toContain("20\\+년");
  expect(sent[0]!.text).not.toContain("\\\\+");
  expect(sent[0]!.text).not.toContain("\\\\=");
});

test("telegram MarkdownV2 repair covers the full reserved character set", () => {
  const rendered = toTelegramMarkdownV2([
    "| symbols | value |",
    "|---|---|",
    "| reserved | _ * [ ] ( ) ~ ` > # + - = | { } . ! \\ |",
  ].join("\n"));
  const reserved = new Set("_*[]()~`>#+-=|{}.!\\");

  for (let index = 0; index < rendered.length - 2; index += 1) {
    const hasDoubleEscapeBeforeReserved =
      rendered[index] === "\\" &&
      rendered[index + 1] === "\\" &&
      reserved.has(rendered[index + 2]!);
    expect(hasDoubleEscapeBeforeReserved).toBe(false);
  }
});

test("telegram adapter keeps source-title tildes literal instead of strikethrough", async () => {
  const sent: TelegramSendRequest[] = [];
  const adapter = createTelegramTransportAdapter({
    sendTelegram: async (input) => {
      sent.push(input);
      return { ok: true, transportMessageId: "1" };
    },
  });

  await adapter.send({
    actionId: "source-title",
    transport: "telegram",
    accountId: "default",
    peer: { kind: "dm", id: "123" },
    message: { text: "**[불인의 길] ~패션쇼 경호 임무!의 서~**" },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    chatId: "123",
    parseMode: "MarkdownV2",
  });
  expect(sent[0]!.text).toBe("*\\[불인의 길\\] \\~패션쇼 경호 임무\\!의 서\\~*");
  expect(sent[0]!.text).not.toContain(" ~패션쇼");
});

test("telegram MarkdownV2 keeps tildes inside inline code untouched", () => {
  expect(toTelegramMarkdownV2("실행: `cd ~/butler`")).toContain("`cd ~/butler`");
});

test("telegram MarkdownV2 escapes source-title tildes across boundary cases", () => {
  expect(toTelegramMarkdownV2("~start")).toBe("\\~start");
  expect(toTelegramMarkdownV2("end~")).toBe("end\\~");
  expect(toTelegramMarkdownV2("a ~one~ b ~two~")).toBe("a \\~one\\~ b \\~two\\~");
  expect(toTelegramMarkdownV2("~~double~~")).toBe("\\~double\\~");
});

test("telegram MarkdownV2 treats escaped backticks as text before tilde escaping", () => {
  expect(toTelegramMarkdownV2("\\`not code ~x~\\`")).toBe("\\`not code \\~x\\~\\`");
});

test("telegram adapter allows explicit text bypass for operator output", async () => {
  const sent: TelegramSendRequest[] = [];
  const adapter = createTelegramTransportAdapter({
    sendTelegram: async (input) => {
      sent.push(input);
      return { ok: true, transportMessageId: "1" };
    },
  });

  await adapter.send({
    actionId: "debug-text",
    transport: "telegram",
    accountId: "default",
    peer: { kind: "dm", id: "123" },
    message: { text: "raw _debug_ output." },
    metadata: { parseMode: "text" },
  });

  expect(sent).toEqual([expect.objectContaining({
    chatId: "123",
    text: "raw _debug_ output.",
    parseMode: undefined,
  })]);
});

test("telegram adapter sends MarkdownV2 messages through Bot API and splits long reports", async () => {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body instanceof URLSearchParams
      ? init.body
      : new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url: String(input), body });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  }) as unknown as typeof fetch;

  const adapter = createTelegramTransportAdapter({
    botToken: "test-token",
    apiBase: "https://telegram.test",
  });
  const result = await adapter.send({
    actionId: "long-report",
    transport: "telegram",
    accountId: "default",
    peer: { kind: "dm", id: "123" },
    message: { text: `보고서\n\n${"가".repeat(4_500)}` },
  });

  expect(result.ok).toBe(true);
  expect(result.transportMessageId).toBe("2");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.url).toBe("https://telegram.test/bottest-token/sendMessage");
  expect(calls[0]!.body.get("chat_id")).toBe("123");
  expect(calls[0]!.body.get("parse_mode")).toBe("MarkdownV2");
  expect(calls[1]!.body.get("parse_mode")).toBe("MarkdownV2");
  expect(calls[0]!.body.get("text")!.length).toBeLessThanOrEqual(3_900);
  expect(calls[1]!.body.get("text")!.length).toBeLessThanOrEqual(3_900);
});
