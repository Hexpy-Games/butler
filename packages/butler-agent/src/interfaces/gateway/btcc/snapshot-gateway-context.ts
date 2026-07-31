import { createHash } from "node:crypto";
import type { ButlerContextInput } from "../../../agent/btcc/contracts.ts";
import type { ContextAssembly, PromptSection } from "../../../agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../../test-support/harness/contracts.ts";
import type { AttachmentRef } from "../../../test-support/harness/contracts.ts";
import type { BtccGatewayActorOptions } from "./contracts.ts";
import { snapshotContextDocuments } from "./context-documents.ts";

export function snapshotGatewayContext(input: {
  binding: StoredSessionBinding;
  assembly: ContextAssembly;
  documents: BtccGatewayActorOptions["contextDocuments"];
  attachments?: AttachmentRef[];
  turnAccessMode?: "full_access" | "ask_first" | "read_only";
}): ButlerContextInput {
  const snapshot = snapshotContextDocuments({
    userRef: principalRef(input.binding),
    sessionId: input.binding.sessionId,
    ...(input.binding.projectId ? { projectRef: input.binding.projectId } : {}),
    workspacePath: input.binding.workspacePath,
    sections: contextSections(input.assembly),
  }, input.documents);
  const attachments = (input.attachments ?? []).map(snapshotAttachment);
  return {
    ...snapshot,
    executionPolicy: executionPolicy(input.binding, input.turnAccessMode),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function executionPolicy(
  binding: StoredSessionBinding,
  turnAccessMode?: "full_access" | "ask_first" | "read_only",
) {
  const metadata = binding.metadata ?? {};
  const runtimePolicy = record(metadata.runtimePolicy);
  return {
    role: binding.role,
    accessMode: turnAccessMode ?? accessMode(runtimePolicy.accessMode ?? metadata.accessMode),
    trackingMode: trackingMode(runtimePolicy.trackingMode ?? runtimePolicy.tracking_mode, binding),
    requiredNativeToolProfiles: uniqueStrings([
      ...stringArray(metadata.requiredNativeToolProfiles),
      ...stringArray(runtimePolicy.requiredNativeToolProfiles),
    ]),
    requiredNativeTools: uniqueStrings([
      ...stringArray(metadata.requiredNativeTools),
      ...stringArray(metadata.required_tools),
      ...stringArray(runtimePolicy.requiredNativeTools),
      ...stringArray(runtimePolicy.required_tools),
    ]),
    workspacePath: binding.workspacePath,
    ...(binding.projectId ? { projectId: binding.projectId } : {}),
  };
}

function snapshotAttachment(attachment: AttachmentRef) {
  return {
    id: attachment.id,
    kind: attachment.kind,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(Number.isFinite(attachment.sizeBytes) ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(attachment.url ? { url: attachment.url } : {}),
    ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
  };
}

function accessMode(value: unknown): "full_access" | "ask_first" | "read_only" {
  if (value === "full_access" || value === "ask_first" || value === "read_only") return value;
  return "read_only";
}

function trackingMode(
  value: unknown,
  binding: StoredSessionBinding,
): "ledger" | "local" | "none" {
  if (value === "ledger" || value === "local" || value === "none") return value;
  return binding.projectId ? "ledger" : "local";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contextSections(assembly: ContextAssembly) {
  const sections = [
    ...assembly.staticContext,
    ...assembly.liveConfiguration,
    ...assembly.runtimeState,
    ...assembly.workingContext,
    ...assembly.retrievedContext,
  ];
  return sections.map((section) => ({
    id: section.id,
    content: renderSection(section),
    projectionClass: section.projectionClass,
    scopeKind: section.scopeKind,
    sourceRevision: digest({
      id: section.id,
      content: section.content,
      projectionClass: section.projectionClass,
      scopeKind: section.scopeKind,
    }),
  }));
}

function renderSection(section: PromptSection): string {
  return `## ${section.title}\n\n${section.content}`;
}

function principalRef(binding: StoredSessionBinding): string {
  const configured = binding.metadata?.userRef;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : "local-principal";
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
