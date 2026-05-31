import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GatewayRouterLike } from "../../packages/butler-agent/src/gateways/core/contracts.ts";
import type { InboundEnvelope, OutboundAction } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { PlannedTaskStore } from "../../packages/butler-agent/src/agent/work/planned-task.ts";
import { normalizeTelegramInbound, type TelegramTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/telegram/adapter.ts";
import { createTelegramNativeControlPlane } from "../../packages/butler-agent/src/interfaces/transport/telegram/native-controls.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-telegram-decision-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("telegram native controls route principal decision callbacks into planned task state and session", async () => {
  const store = new PlannedTaskStore(tempDir);
  const record = store.create({
    task_id: "planned-decision-flow",
    type: "planned",
    goal: "Need principal choice",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "critical only",
    acceptance_criteria: ["decision is recorded"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  store.transition(record.taskId, "BLOCKED_WAITING_PRINCIPAL");
  store.writeDecision(record.taskId, {
    decision_id: "dec-flow",
    task_id: record.taskId,
    situation: "External cost is required.",
    recommended_option_id: "approve",
    options: [
      { id: "approve", label: "Approve", description: "Use the paid service." },
      { id: "skip", label: "Skip", description: "Avoid the cost." },
    ],
    tradeoffs: ["Approve is faster; skip is cheaper."],
    expires_at: null,
    created_at: "2026-04-25T00:00:00.000Z",
    response: null,
  });

  let inboundHandler: ((event: InboundEnvelope) => Promise<void>) | undefined;
  const sent: OutboundAction[] = [];
  const inbound: InboundEnvelope[] = [];
  const adapter: TelegramTransportAdapter = {
    id: "telegram",
    capabilities: {
      supportsThreads: true,
      supportsMessageEdit: true,
      supportsReactions: false,
      supportsAttachments: false,
      supportsStreamingEdits: false,
      supportsPresence: true,
    },
    async start(handler) {
      inboundHandler = handler;
    },
    async send(action) {
      sent.push(action);
      return { ok: true, transportMessageId: String(sent.length) };
    },
    async emitInbound(input) {
      const envelope = normalizeTelegramInbound(input);
      inbound.push(envelope);
      await inboundHandler?.(envelope);
    },
  };
  await adapter.start(async (event) => {
    inbound.push(event);
  });

  const router: GatewayRouterLike = {
    routeInbound: () => ({
      status: "routed",
      route: {
        sessionId: "butler/main",
        role: "butler",
        reason: "butler-fallback",
        workspacePath: "/tmp/project",
      },
    }),
  };
  const controls = await createTelegramNativeControlPlane({
    adapter,
    router,
    butlerData: tempDir,
  });

  const result = await controls.handleCallbackQuery({
    chatId: "123",
    chatType: "private",
    messageId: "10",
    senderId: "user-1",
    data: "pd:dec-flow:approve",
    timestamp: "2026-04-25T00:00:00.000Z",
  });

  expect(result.outcome).toBe("handled");
  expect(store.read(record.taskId)?.decision?.response).toMatchObject({
    option_id: "approve",
    transport: "telegram",
    actor_id: "user-1",
  });
  expect(sent[0]?.message.text).toBe("Decision recorded: approve");
  expect(inbound.some((event) => event.message.text?.includes("principal decision answered"))).toBe(true);
});
