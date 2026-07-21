import { createHash } from "node:crypto";
import {
  snapshotButlerContext,
  type ButlerContextSnapshot,
} from "../../../agent/btcc/context/index.ts";
import type { ContextAssembly, PromptSection } from "../../../agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../../test-support/harness/contracts.ts";
import type { BtccGatewayActorOptions } from "./contracts.ts";

export function snapshotGatewayContext(input: {
  binding: StoredSessionBinding;
  assembly: ContextAssembly;
  documents: BtccGatewayActorOptions["contextDocuments"];
}): ButlerContextSnapshot {
  return snapshotButlerContext({
    userRef: principalRef(input.binding),
    sessionId: input.binding.sessionId,
    ...(input.binding.projectId ? { projectRef: input.binding.projectId } : {}),
    workspacePath: input.binding.workspacePath,
    sections: contextSections(input.assembly),
  }, input.documents);
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
    sourceRevision: digest({ id: section.id, content: section.content }),
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
