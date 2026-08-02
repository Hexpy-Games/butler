import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { InboundEnvelope, OutboundAction, TransportAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";
import { createTelegramTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/telegram/adapter.ts";
import {
  finalAggregateSummaryFromTurnEvents,
  shouldProjectTurnEventAsProgressDraft,
  shouldProjectTurnEventLive,
  turnEventProjectionMode,
} from "../../packages/butler-agent/src/interfaces/transport/turn-event-projection.ts";

interface AdapterFixture {
  id: string;
  create(): {
    adapter: TransportAdapter & {
      emitInbound?: (input: any) => Promise<void>;
    };
    inboundInput: unknown;
    sent: OutboundAction[];
  };
}

const fixtures: AdapterFixture[] = [
  {
    id: "mock",
    create() {
      const adapter = new MockTransportAdapter({ id: "mock" });
      return {
        adapter,
        inboundInput: {
          eventId: "mock:event:1",
          transport: "mock",
          accountId: "default",
          peer: { kind: "dm", id: "peer-1" },
          sender: { id: "user-1" },
          message: {
            id: "msg-1",
            text: "hello",
            timestamp: new Date(0).toISOString(),
          },
        } satisfies InboundEnvelope,
        sent: adapter.sentActions,
      };
    },
  },
  {
    id: "telegram",
    create() {
      const sent: OutboundAction[] = [];
      const adapter = createTelegramTransportAdapter({
        botToken: "test-token",
        sendTelegram: async (request) => {
          sent.push({
            actionId: `telegram-send:${sent.length}`,
            transport: "telegram",
            accountId: "default",
            peer: { kind: "dm", id: request.chatId },
            message: { text: request.text },
          });
          return { ok: true, transportMessageId: `telegram:${sent.length}` };
        },
      });
      return {
        adapter,
        inboundInput: {
          chatId: "chat-1",
          chatType: "private",
          messageId: "msg-1",
          text: "hello",
          senderId: "user-1",
          timestamp: new Date(0).toISOString(),
        },
        sent,
      };
    },
  },
];

function outboundAction(transport: string): OutboundAction {
  return {
    actionId: "action-1",
    transport,
    accountId: "default",
    peer: { kind: "dm", id: "peer-1" },
    message: { text: "reply" },
    metadata: { source: "transport-conformance.test.ts" },
  };
}

for (const fixture of fixtures) {
  test(`${fixture.id} transport satisfies adapter conformance`, async () => {
    const { adapter, inboundInput, sent } = fixture.create();
    const inbound: InboundEnvelope[] = [];
    await adapter.start(async (event) => {
      inbound.push(event);
    });

    if (adapter instanceof MockTransportAdapter) {
      await adapter.emit(inboundInput as InboundEnvelope);
    } else {
      await adapter.emitInbound?.(inboundInput);
    }

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      transport: fixture.id,
      accountId: "default",
      message: { text: "hello" },
    });
    expect(adapter.capabilities).toEqual(expect.objectContaining({
      supportsThreads: expect.any(Boolean),
      supportsMessageEdit: expect.any(Boolean),
      supportsPresence: expect.any(Boolean),
      supportsFinalAggregateOnly: expect.any(Boolean),
    }));

    const delivery = await adapter.send(outboundAction(fixture.id));
    expect(delivery.ok).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(1);

    const wrongTransport = await adapter.send(outboundAction("wrong"));
    if (fixture.id === "telegram") {
      expect(wrongTransport.ok).toBe(false);
    }
  });
}

test("delivery guard deduplicates transport actions for conformance fixtures", async () => {
  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });

  const first = await guard.deliver("butler/main", outboundAction("mock"));
  const second = await guard.deliver("butler/main", outboundAction("mock"));

  expect(first.ok).toBe(true);
  expect(second).toMatchObject({ ok: true, duplicate: true });
  expect(mock.sentActions).toHaveLength(1);
});

test("turn event projection follows transport capabilities", () => {
  const mock = new MockTransportAdapter({ id: "mock" });
  const telegram = createTelegramTransportAdapter({ botToken: "test-token" });
  const event = {
    kind: "tool.started",
    visibility: "public",
  } as const;

  expect(turnEventProjectionMode(mock.capabilities)).toBe("live_activity");
  expect(shouldProjectTurnEventLive(mock.capabilities, event)).toBe(true);
  expect(shouldProjectTurnEventAsProgressDraft(mock.capabilities, event)).toBe(false);

  expect(turnEventProjectionMode(telegram.capabilities)).toBe("progress_draft");
  expect(shouldProjectTurnEventLive(telegram.capabilities, event)).toBe(false);
  expect(shouldProjectTurnEventAsProgressDraft(telegram.capabilities, event)).toBe(true);

  expect(turnEventProjectionMode({
    supportsThreads: false,
    supportsMessageEdit: false,
    supportsReactions: false,
    supportsAttachments: false,
    supportsStreamingEdits: false,
    supportsPresence: false,
  })).toBe("final_aggregate");
  expect(finalAggregateSummaryFromTurnEvents([
    event,
    { kind: "guard.completed", visibility: "public" },
  ])).toBe("1 safe activity event, response checked");
});

test("BTCC Gateway adapters remain transport-agnostic", () => {
  const gatewayRoot = join(
    process.cwd(),
    "packages",
    "butler-agent",
    "src",
    "interfaces",
    "gateway",
    "btcc",
  );
  const adapterFiles = [
    "btcc-inbound-dispatcher.ts",
    "create-btcc-gateway-handlers.ts",
    "project-turn-outcome.ts",
  ].map((file) => join(gatewayRoot, file));
  for (const file of adapterFiles) {
    expect(readFileSync(file, "utf8")).not.toMatch(/telegram/i);
  }
});
