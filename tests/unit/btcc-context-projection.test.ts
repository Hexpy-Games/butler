import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotButlerContext,
  type ContextDocumentWriter,
} from "../../packages/butler-agent/src/agent/btcc/context/index.ts";
import {
  PromptAssembler,
  type ContextAssembly,
} from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { snapshotGatewayContext } from "../../packages/butler-agent/src/interfaces/gateway/btcc/snapshot-gateway-context.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

type PersistedDocument = Parameters<ContextDocumentWriter["persist"]>[0];

class RecordingContextDocuments implements ContextDocumentWriter {
  readonly records: PersistedDocument[] = [];

  persist(input: PersistedDocument): string {
    this.records.push(input);
    return `context:${this.records.length}`;
  }
}

test("BTCC projects context from typed metadata without interpreting the section id", () => {
  const documents = new RecordingContextDocuments();
  const snapshot = snapshotButlerContext({
    userRef: "user-1",
    sessionId: "session-1",
    workspacePath: "/workspace",
    sections: [{
      id: "this-id-carries-no-category",
      content: "recent preference",
      sourceRevision: "revision-1",
      projectionClass: "recent_feedback",
      scopeKind: "user",
    }],
  }, documents);

  expect(snapshot.recentFeedbackRefs).toEqual(["context:1"]);
  expect(snapshot.optionalHotCacheRefs).toEqual([]);
  expect(documents.records[0]).toMatchObject({
    sourceId: "this-id-carries-no-category",
    projectionClass: "recent_feedback",
    scopeKind: "user",
    scopeId: "user-1",
  });
});

test("BTCC rejects project-scoped context when no project binding exists", () => {
  const documents = new RecordingContextDocuments();

  expect(() => snapshotButlerContext({
    userRef: "user-1",
    sessionId: "session-1",
    workspacePath: "/workspace",
    sections: [{
      id: "project-memory",
      content: "project-only context",
      sourceRevision: "revision-1",
      projectionClass: "optional_hot_cache",
      scopeKind: "project",
    }],
  }, documents)).toThrow("BTCC project context section requires a project binding");
  expect(documents.records).toEqual([]);
});

test("Gateway context does not grant write access when the binding has no access policy", () => {
  const documents = new RecordingContextDocuments();
  const assembly: ContextAssembly = {
    staticContext: [],
    liveConfiguration: [],
    runtimeState: [],
    workingContext: [],
    retrievedContext: [],
    currentInput: [],
    references: [],
    liveConfigHash: "empty",
  };
  const snapshot = snapshotGatewayContext({
    binding: sessionBinding("/workspace"),
    assembly,
    documents,
  });

  expect(snapshot.executionPolicy?.accessMode).toBe("read_only");
});

test("Gateway context snapshots the queued Turn access instead of a later wider session setting", () => {
  const binding = sessionBinding("/workspace");
  binding.metadata = {
    runtimePolicy: { accessMode: "full_access", trackingMode: "none" },
  };
  const assembly: ContextAssembly = {
    staticContext: [],
    liveConfiguration: [],
    runtimeState: [],
    workingContext: [],
    retrievedContext: [],
    currentInput: [],
    references: [],
    liveConfigHash: "empty",
  };
  const snapshot = snapshotGatewayContext({
    binding,
    assembly,
    documents: new RecordingContextDocuments(),
    turnAccessMode: "read_only",
  });

  expect(snapshot.executionPolicy?.accessMode).toBe("read_only");
});

test("PromptAssembler metadata survives the real Gateway to BTCC snapshot path", () => {
  const root = join(tmpdir(), `btcc-context-projection-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "rules"), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "system");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "role");
  writeFileSync(join(butlerData, "cognition", "memory", "rules", "INDEX.md"), "- [Core](core.md)");
  writeFileSync(join(butlerData, "cognition", "memory", "rules", "core.md"), "rule body");

  try {
    const binding = sessionBinding(workspacePath);
    binding.metadata = {
      ...binding.metadata,
      runtimePolicy: {
        accessMode: "read_only",
        trackingMode: "local",
        requiredNativeToolProfiles: ["public-web"],
        requiredNativeTools: ["web_search"],
      },
    };
    const assembly = new PromptAssembler({ butlerHome, butlerData }).buildButlerContextAssembly({
      binding,
      envelope: {
        eventId: "event-1",
        transport: "app",
        accountId: "local",
        peer: { kind: "dm", id: "peer-1" },
        sender: { id: "user-1" },
        message: {
          id: "message-1",
          text: "hello",
          timestamp: new Date(0).toISOString(),
        },
      },
    });
    const rules = assembly.liveConfiguration.find((section) => section.id === "rules");
    expect(rules).toMatchObject({
      projectionClass: "mandatory_hot_cache",
      scopeKind: "user",
    });

    const documents = new RecordingContextDocuments();
    const snapshot = snapshotGatewayContext({
      binding,
      assembly,
      documents,
      attachments: [{
        id: "file-attachment",
        kind: "document",
        mimeType: "text/csv",
        fileName: "products.csv",
        sizeBytes: 42,
        localPath: join(root, "products.csv"),
        metadata: { transient: "not-admitted" },
      }],
    });
    const persistedRules = documents.records.find((record) => record.sourceId === "rules");
    expect(persistedRules).toMatchObject({
      projectionClass: "mandatory_hot_cache",
      scopeKind: "user",
      scopeId: "user-1",
    });
    expect(snapshot.mandatoryHotCacheRefs).toContain(
      `context:${documents.records.indexOf(persistedRules!) + 1}`,
    );
    expect(snapshot.executionPolicy).toEqual({
      role: "butler",
      accessMode: "read_only",
      trackingMode: "local",
      requiredNativeToolProfiles: ["public-web"],
      requiredNativeTools: ["web_search"],
      workspacePath,
    });
    expect(snapshot.attachments).toEqual([{
      id: "file-attachment",
      kind: "document",
      mimeType: "text/csv",
      fileName: "products.csv",
      sizeBytes: 42,
      localPath: join(root, "products.csv"),
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sessionBinding(workspacePath: string): StoredSessionBinding {
  const timestamp = new Date(0).toISOString();
  return {
    sessionId: "butler/main",
    role: "butler",
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
    metadata: { userRef: "user-1" },
    lifecycleState: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
