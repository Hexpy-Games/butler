import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { providerImageAttachments } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
import { attachmentImageDataUrl } from "../../packages/butler-agent/src/agent/context/attachment-context.ts";
import { OPENAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/openai/catalog.ts";
import type { ButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";
import type { VisualAttachmentManifest } from "../../packages/butler-agent/src/gateways/core/contracts.ts";
import {
  admitVisualImageRequest,
  createFileStoreVerifiedImagePayloadPort,
  createVisualManifest,
  imageAdmissionForCatalogEntry,
  serializeOpenAIChatVisualContent,
  serializeOpenAIVisualInput,
  type ImageCapabilityCatalogEntry,
  type ImageCapabilityEvidence,
  type ImageCarrierTuple,
  type VerifiedImagePayloadPort,
} from "../../packages/butler-agent/src/agent/image-attachment/index.ts";
import { registeredHostedModelMetadata } from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import { QWEN_MODELS } from "../../packages/butler-agent/src/integrations/providers/qwen/catalog.ts";
import { runHostedOpenAICompatibleModelRound } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-tool-runtime.ts";
import type { HostedRuntimeConfig } from "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

function tuple(overrides: Partial<ImageCarrierTuple> = {}): ImageCarrierTuple {
  return {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    carrierProtocol: "openai_responses",
    endpointProfileId: "openai-responses-v1",
    catalogCapabilityRevision: "2026-08-09",
    catalogCapabilityDigest: "catalog-image-fixture",
    ...overrides,
  };
}

function capability(overrides: Partial<ImageCapabilityEvidence> = {}): ImageCapabilityEvidence {
  return {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    carrierProtocol: "openai_responses",
    endpointProfileId: "openai-responses-v1",
    catalogCapabilityRevision: "2026-08-09",
    catalogCapabilityDigest: "catalog-image-fixture",
    modelSupport: "supported",
    capabilitySource: "provider_catalog",
    routeHealth: "unchecked",
    inputModalities: ["text", "image"],
    acceptedMimeTypes: ["image/png"],
    maxInlineImageBytes: 10 * 1024 * 1024,
    maxWidth: 4096,
    maxHeight: 4096,
    maxPixels: 16_000_000,
    sourceUrl: "https://developers.openai.com/api/docs/models",
    verifiedAt: "2026-08-09T00:00:00.000Z",
    evidenceRevision: "2026-08-09",
    evidenceDigest: "catalog-image-fixture",
    ...overrides,
  };
}

function catalogEntry(
  overrides: Partial<ImageCapabilityCatalogEntry> = {},
): ImageCapabilityCatalogEntry {
  return {
    provider_id: "fixture",
    model_id: "vision-model",
    model_ref: "fixture/vision-model",
    runtime_supported: true,
    image_input_support: "supported",
    image_capability_source: "provider_catalog",
    image_route_health: "unchecked",
    image_input_modalities: ["text", "image"],
    image_accepted_mime_types: ["image/png"],
    image_max_inline_bytes: 10 * 1024 * 1024,
    image_max_width: 4096,
    image_max_height: 4096,
    image_max_pixels: 16_000_000,
    image_capability_source_url: "https://provider.example/models",
    image_capability_verified_at: "2026-08-09T00:00:00.000Z",
    image_capability_revision: "fixture-vision-v1",
    image_capability_digest: "fixture-vision-digest",
    image_endpoint_profile_id: "fixture-vision-endpoint",
    image_carrier_protocol: "fake_vision",
    ...overrides,
  };
}

function manifest() {
  return createVisualManifest({
    fileId: "file-44444444-4444-4444-8444-444444444444",
    safeName: "sample.png",
    mimeType: "image/png",
    sourceBytes: PNG_1X1,
    derivativeBytes: PNG_1X1,
    position: 0,
  });
}

test("admits documented image support without requiring a positive route probe", () => {
  for (const routeHealth of ["unchecked", "healthy", "transient_failure"] as const) {
    const admitted = imageAdmissionForCatalogEntry(
      catalogEntry({ image_route_health: routeHealth }),
      [manifest()],
    );
    expect(admitted.capability.modelSupport).toBe("supported");
    expect(admitted.capability.routeHealth).toBe(routeHealth);
  }
});

test("distinguishes unsupported, unknown, unavailable carrier, and incompatible route", () => {
  expect(() => imageAdmissionForCatalogEntry(
    catalogEntry({ image_input_support: "unsupported" }),
    [manifest()],
  )).toThrow("image_model_unsupported");
  expect(() => imageAdmissionForCatalogEntry(
    catalogEntry({ image_input_support: "unknown" }),
    [manifest()],
  )).toThrow("image_capability_unknown");
  expect(() => imageAdmissionForCatalogEntry(
    catalogEntry({ image_carrier_protocol: undefined }),
    [manifest()],
  )).toThrow("image_carrier_unavailable");
  expect(() => imageAdmissionForCatalogEntry(
    catalogEntry({ image_route_health: "incompatible" }),
    [manifest()],
  )).toThrow("image_route_incompatible");
});

test("uses capability facts instead of provider or model name exceptions", () => {
  for (const carrier of [
    "openai_responses",
    "openai_chat_completions",
    "zai_mcp_vision",
    "fake_vision",
  ] as const) {
    const admitted = imageAdmissionForCatalogEntry(catalogEntry({
      provider_id: `provider-${carrier}`,
      model_id: `model-${carrier}`,
      model_ref: `provider-${carrier}/model-${carrier}`,
      image_carrier_protocol: carrier,
    }), [manifest()]);
    expect(admitted.tuple.carrierProtocol).toBe(carrier);
  }
  expect(OPENAI_MODELS.every((model) =>
    model.image_input_support === "supported" &&
    model.image_carrier_protocol === "openai_responses",
  )).toBe(true);
});

test("rejects the exact Z.AI Coding tuple before provider admission", () => {
  const unsupportedTuple = tuple({
    providerId: "zai",
    modelId: "glm-5.2",
    carrierProtocol: "openai_chat_completions",
    endpointProfileId: "zai-coding-chat-v4",
  });
  const manifest = createVisualManifest({
    fileId: "file-00000000-0000-4000-8000-000000000001",
    safeName: "sample.png",
    mimeType: "image/png",
    sourceBytes: PNG_1X1,
    derivativeBytes: PNG_1X1,
    position: 0,
  });

  expect(() => admitVisualImageRequest({
    tuple: unsupportedTuple,
    capability: capability({
      providerId: unsupportedTuple.providerId,
      modelId: unsupportedTuple.modelId,
      carrierProtocol: unsupportedTuple.carrierProtocol,
      endpointProfileId: unsupportedTuple.endpointProfileId,
      catalogCapabilityRevision: unsupportedTuple.catalogCapabilityRevision,
      catalogCapabilityDigest: unsupportedTuple.catalogCapabilityDigest,
      evidenceRevision: unsupportedTuple.catalogCapabilityRevision,
      evidenceDigest: unsupportedTuple.catalogCapabilityDigest,
      inputModalities: ["text"],
    }),
    manifests: [manifest],
  })).toThrow("image_model_unsupported");
});

test("serializes a supported fake/OpenAI visual carrier with path-free manifest data", async () => {
  const manifest = createVisualManifest({
    fileId: "file-11111111-1111-4111-8111-111111111111",
    safeName: "pixel.png",
    mimeType: "image/png",
    sourceBytes: PNG_1X1,
    derivativeBytes: PNG_1X1,
    position: 0,
  });
  const payloadPort: VerifiedImagePayloadPort = {
    async read(payload) {
      expect(payload.derivativeId).toBe(manifest.derivativeId);
      return { bytes: PNG_1X1, mimeType: "image/png" };
    },
  };
  admitVisualImageRequest({
    tuple: tuple(),
    capability: capability(),
    manifests: [manifest],
  });

  const serialized = await serializeOpenAIVisualInput({
    text: "봐봐",
    manifests: [manifest],
    payloadPort,
  });
  expect(serialized).toEqual([{
    role: "user",
    content: [
      { type: "input_text", text: "봐봐" },
      { type: "input_image", image_url: expect.stringMatching(/^data:image\/png;base64,/) },
    ],
  }]);
  expect(JSON.stringify(serialized)).not.toContain("localPath");
  expect(JSON.stringify(serialized)).not.toContain("file-11111111-1111-4111-8111-111111111111");
});

test("serializes admitted pixels for OpenAI-compatible Chat Completions adapters", async () => {
  const visualManifest = manifest();
  const content = await serializeOpenAIChatVisualContent({
    text: "what is visible?",
    manifests: [visualManifest],
    payloadPort: {
      read: async () => ({ bytes: PNG_1X1, mimeType: "image/png" }),
    },
  });
  expect(content).toEqual([
    { type: "text", text: "what is visible?" },
    {
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    },
  ]);
  expect(QWEN_MODELS.find((model) => model.model_id === "qwen3.7-plus"))
    .toMatchObject({
      image_input_support: "supported",
      image_carrier_protocol: "openai_chat_completions",
    });
  expect(QWEN_MODELS.find((model) => model.model_id === "qwen3.7-max")?.image_input_support)
    .toBe("unsupported");
});

test("sends admitted pixels through the hosted Chat Completions adapter", async () => {
  const bodies: Array<Record<string, any>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      bodies.push(await request.json());
      return Response.json({
        model: "qwen3.7-plus",
        choices: [{ message: { role: "assistant", content: "image seen" } }],
      });
    },
  });
  const config: HostedRuntimeConfig = {
    providerId: "qwen",
    modelId: "qwen3.7-plus",
    modelRef: "qwen/qwen3.7-plus",
    authType: "api_key",
    apiKey: "test-key",
    apiBaseUrl: server.url.toString(),
  };
  const visualManifest = manifest();

  try {
    const result = await runHostedOpenAICompatibleModelRound(config, {
      model: config.modelRef,
      messages: [{ role: "user", content: "what is visible?" }],
      tools: [],
      imageCarrier: tuple({
        providerId: "qwen",
        modelId: "qwen3.7-plus",
        carrierProtocol: "openai_chat_completions",
        endpointProfileId: "qwen-chat-completions-v1",
      }),
      imageManifests: [visualManifest],
      verifiedImagePayloadPort: {
        read: async () => ({ bytes: PNG_1X1, mimeType: "image/png" }),
      },
    });

    expect(result.text).toBe("image seen");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "what is visible?" },
      {
        type: "image_url",
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
      },
    ]);
    expect(JSON.stringify(bodies[0])).not.toContain(visualManifest.fileId);
  } finally {
    server.stop(true);
  }
});

test("rejects the exact Z.AI Coding image send before either durable queue stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-iac-public-"));
  const providerCalls: unknown[] = [];
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    responder(input) {
      providerCalls.push(input);
      return { texts: ["must not run"] };
    },
  });
  try {
    const upload = new FormData();
    upload.set("session_id", "general");
    upload.set("file", new Blob([PNG_1X1], { type: "image/png" }), "pixel.png");
    const uploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: upload,
    });
    expect(uploadResponse.status).toBe(201);
    const uploadBody = await uploadResponse.json() as {
      data: { file: { file_id: string } };
    };

    // Leave an active turn in place so this request would take the durable
    // session_queued_messages branch after admission. The gate must run first.
    const activeTurn = server.store.insertTurn("general", "thinking", "Thinking", {
      controls: {
        model: "zai/glm-5.2",
        reasoning_effort: "medium",
        access_mode: "read_only",
        plan_mode: false,
      },
      source: "message_override",
      sessionControlRevision: 0,
      catalogGeneration: "test-image-carrier",
      model_fallback: { enabled: false, models: [] },
    });
    const turnBefore = server.store.db.query<{
      state: string;
      safe_status_label: string;
      cancellable: number;
      retryable: number;
    }, [string]>(
      "SELECT state, safe_status_label, cancellable, retryable FROM turns WHERE id = ?",
    ).get(activeTurn.id);
    const eventCountBefore = server.store.db
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM events WHERE turn_id = ?")
      .get(activeTurn.id)?.count ?? 0;

    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        model: "zai/glm-5.2",
        text: "inspect this",
        queue_policy: "enqueue_if_busy",
        attachments: [{ file_id: uploadBody.data.file.file_id }],
      }),
    });
    const body = await response.json() as {
      error?: { code?: string };
    };
    expect(response.status).toBe(409);
    expect(body.error?.code).toBe("image_model_unsupported");
    expect(server.store.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages")
      .get()?.count).toBe(0);
    expect(server.store.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_queued_messages")
      .get()?.count).toBe(0);
    expect(providerCalls).toHaveLength(0);
    const turnAfter = server.store.db.query<{
      state: string;
      safe_status_label: string;
      cancellable: number;
      retryable: number;
    }, [string]>(
      "SELECT state, safe_status_label, cancellable, retryable FROM turns WHERE id = ?",
    ).get(activeTurn.id);
    expect(turnAfter).toEqual(turnBefore);
    expect(server.store.db
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM events WHERE turn_id = ?")
      .get(activeTurn.id)?.count).toBe(eventCountBefore);
    expect(server.store.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM events WHERE turn_id = ? AND lower(type) LIKE '%provider%'",
      ).get(activeTurn.id)?.count).toBe(0);
    expect(server.store.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM events WHERE turn_id = ? AND lower(type) LIKE '%fallback%'",
      ).get(activeTurn.id)?.count).toBe(0);
    expect(readdirSync(join(root, "app-server", "message-files"))
      .filter((name) => name.endsWith(".visual"))).toHaveLength(0);

    const forgedQueueResponse = await fetch(`${server.url}session-queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        model: "zai/glm-5.2",
        text: "forged queue admission",
        attachments: [{ file_id: uploadBody.data.file.file_id }],
        visualAdmission: {
          tuple: tuple(),
          capability: capability(),
          manifests: [],
        },
      }),
    });
    expect(forgedQueueResponse.status).toBe(409);
    expect(server.store.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_queued_messages")
      .get()?.count).toBe(0);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the admitted visual manifest's file identity on the BTCC carrier path", () => {
  const manifest = createVisualManifest({
    fileId: "file-22222222-2222-4222-8222-222222222222",
    safeName: "pixel.png",
    mimeType: "image/png",
    sourceBytes: PNG_1X1,
    derivativeBytes: PNG_1X1,
    position: 0,
  });
  const attachments = providerImageAttachments({
    turnId: "turn-image-carrier",
    context: {
      attachments: [{
        id: manifest.fileId,
        kind: "image",
        mimeType: "image/png",
        fileName: manifest.safeName,
        visualManifest: manifest,
      }],
    },
  } as never);
  expect(attachments).toHaveLength(1);
  expect(attachments[0]?.id).toBe(manifest.fileId);
  expect(attachments[0]?.visualManifest).toEqual(manifest);
  expect(attachments[0]?.localPath).toBeUndefined();
});

test("does not resolve image pixels from an original attachment path", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-iac-path-"));
  const originalPath = join(root, "original.png");
  writeFileSync(originalPath, PNG_1X1);
  try {
    expect(() => attachmentImageDataUrl({
      id: "file-33333333-3333-4333-8333-333333333333",
      kind: "image",
      mimeType: "image/png",
      localPath: originalPath,
    })).toThrow("verified_image_payload_port_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("carries a supported visual tuple from upload through both queues to the native serializer", async () => {
  const model = OPENAI_MODELS.find((candidate) => candidate.model_ref === "openai/gpt-5.6-sol");
  if (!model) throw new Error("vision fixture model missing");
  expect(model.image_input_support).toBe("supported");
  expect(model.image_route_health).toBe("unchecked");

  const root = mkdtempSync(join(tmpdir(), "butler-iac-supported-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2026-08-09T00:00:00.000Z",
      runtime: "test",
      launcher: "test",
    }),
  );
  const transportInputs: Array<{ attachments?: unknown[] }> = [];
  const serviceClient: ButlerServiceClient = {
    findAppTurn() {
      return null;
    },
    enqueueAppCancellation() {
      throw new Error("cancellation is not expected in this fixture");
    },
    enqueueAppTurn(input) {
      transportInputs.push({ attachments: input.attachments });
      return {
        version: 1,
        queueId: `vision-fixture-${transportInputs.length}`,
        envelope: {} as never,
        enqueuedAt: new Date().toISOString(),
        attempts: 0,
        metadata: {},
      };
    },
  };
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    serviceClient,
    automationSchedulerIntervalMs: false,
  });
  try {
    server.store.registerHostedModel({
      provider_id: "openai",
      model_id: "gpt-5.6-sol",
      auth_type: "api_key",
      api_key: "vision-fixture-key",
      api_base_url: "http://vision-fixture.test/v1",
    });
    const registered = registeredHostedModelMetadata(root)
      .find((candidate) => candidate.model_ref === "openai/gpt-5.6-sol");
    expect(registered?.image_input_support).toBe("supported");
    expect(registered?.image_route_health).toBe("unchecked");
    const upload = new FormData();
    upload.set("session_id", "general");
    upload.set("file", new Blob([PNG_1X1], { type: "image/png" }), "pixel.png");
    const uploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: upload,
    });
    const uploadBody = await uploadResponse.json() as {
      data: { file: { file_id: string } };
    };
    expect(uploadResponse.status).toBe(201);

    const activeTurn = server.store.insertTurn("general", "thinking", "Thinking", {
      controls: {
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "medium",
        access_mode: "read_only",
        plan_mode: false,
      },
      source: "message_override",
      sessionControlRevision: 0,
      catalogGeneration: "vision-fixture",
      model_fallback: { enabled: false, models: [] },
    });
    server.store.updateTurnState(activeTurn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
      retryable: false,
    });
    const queuedResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        model: "openai/gpt-5.6-sol",
        text: "inspect this",
        queue_policy: "enqueue_if_busy",
        attachments: [{ file_id: uploadBody.data.file.file_id }],
      }),
    });
    expect(queuedResponse.status).toBe(202);
    expect(server.store.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_queued_messages WHERE state = 'queued'")
      .get()?.count).toBe(1);
    expect(transportInputs).toHaveLength(0);
    const queued = server.store.db.query<{ attachments_json: string }, []>(
      "SELECT attachments_json FROM session_queued_messages WHERE state = 'queued' ORDER BY created_at DESC LIMIT 1",
    ).get();
    if (!queued) throw new Error("queued_visual_message_missing");
    const queuedAttachments = JSON.parse(queued.attachments_json) as Array<{
      file_id?: string;
      image_admission?: {
        tuple?: ImageCarrierTuple;
        manifests?: VisualAttachmentManifest[];
      };
    }>;
    expect(queuedAttachments[0]?.file_id).toBe(uploadBody.data.file.file_id);
    expect(queuedAttachments[0]?.image_admission?.tuple).toEqual(expect.objectContaining({
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      carrierProtocol: "openai_responses",
      endpointProfileId: "openai-responses-v1",
    }));
    expect(queuedAttachments[0]?.image_admission?.manifests?.[0]).toEqual(expect.objectContaining({
      kind: "image",
      fileId: uploadBody.data.file.file_id,
      sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      derivativeDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }));
    expect(JSON.stringify(queuedAttachments)).not.toContain(root);
    expect(JSON.stringify(queuedAttachments)).not.toContain("localPath");
    const queuedAdmission = queuedAttachments[0]?.image_admission;
    if (!queuedAdmission?.manifests?.[0]) throw new Error("queued_visual_manifest_missing");
    const serialized = await serializeOpenAIVisualInput({
      text: "inspect this",
      manifests: queuedAdmission.manifests,
      payloadPort: createFileStoreVerifiedImagePayloadPort(root),
    });
    expect(serialized[0]?.content).toHaveLength(2);
    expect(serialized[0]?.content[1]).toMatchObject({ type: "input_image" });
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
