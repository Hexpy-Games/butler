import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import { DEFAULT_MODEL_REF } from "../../../../integrations/providers/model-catalog.ts";
import type { SessionTransportBinding } from "../../../../test-support/harness/contracts.ts";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import type { ChatKind } from "../../interface/protocol/app-protocol.ts";
import {
  isRecord,
  safeOptionalShortText,
  safeOptionalShortToken,
} from "../core/projection-safe-values.ts";

export function isInternalContinuationTurnState(state: string): boolean {
  return state === "retrying" || state === "waiting_for_tool";
}

export function isAppWorkerResultOutbound(
  metadata: Record<string, unknown>,
): boolean {
  return metadata.kind === "worker_result" || metadata.type === "worker-result";
}

export function runtimeTurnEventFromAppOutboundMetadata(
  metadata: Record<string, unknown>,
): RuntimeTurnEventInput | null {
  if (metadata.kind !== "turn_event") return null;
  const event = isRecord(metadata.event) ? metadata.event : null;
  if (!event) return null;
  const kind = safeOptionalShortToken(event.kind);
  if (!kind) return null;
  return {
    kind: kind as RuntimeTurnEventInput["kind"],
    ...(event.visibility === "internal" ? { visibility: "internal" as const } : {}),
    ...(isRecord(event.payload) ? { payload: event.payload } : {}),
    ...(safeOptionalShortText(event.createdAt)
      ? { createdAt: safeOptionalShortText(event.createdAt) }
      : {}),
  };
}

export function loadedSkillNamesFromTranscriptEvent(
  event: TranscriptEvent | undefined,
  turnId?: string,
): string[] | null {
  if (!event) return null;
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.kind === "outbound") {
    const metadata = isRecord(payload.metadata) ? payload.metadata : {};
    if (metadata.kind !== "final_result") return null;
    const eventTurnId = safeOptionalShortToken(metadata.turnId);
    if (turnId && eventTurnId !== turnId) return null;
    return safeSkillNameList(metadata.loadedSkillNames);
  }
  if (event.kind !== "system" || payload.category !== "context.skills.loaded") {
    return null;
  }
  const details = isRecord(payload.details) ? payload.details : {};
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const eventTurnId =
    safeOptionalShortToken(details.turnId) ??
    safeOptionalShortToken(metadata.turnId);
  if (turnId && eventTurnId !== turnId) return null;
  return safeSkillNameList(details.skillNames);
}

export function provisionalSessionTitleFromPrompt(
  text: string,
  kind: ChatKind = "chat",
): string {
  const firstLine = text.trim().split(/\r?\n/u)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/gu, " ").trim();
  if (!collapsed) return kind === "project" ? "New project chat" : "New chat";
  return collapsed.length > 48 ? `${collapsed.slice(0, 45)}...` : collapsed;
}

export function normalizeGeneratedSessionTitle(value: unknown): string | null {
  const safe = safeOptionalShortText(value);
  if (!safe) return null;
  const unquoted = safe
    .replace(/^["'`]+/u, "")
    .replace(/["'`.]+$/u, "")
    .replace(/^#+\s*/u, "")
    .trim();
  if (!unquoted || unquoted === "New chat" || unquoted === "New project chat") {
    return null;
  }
  return unquoted.length > 64 ? `${unquoted.slice(0, 61)}...` : unquoted;
}

export function mergeTransportBindings(
  bindings: SessionTransportBinding[],
): SessionTransportBinding[] {
  const seen = new Set<string>();
  const output: SessionTransportBinding[] = [];
  for (const binding of bindings) {
    const key = [
      binding.transport,
      binding.accountId,
      binding.peerId,
      binding.threadId ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      transport: binding.transport,
      accountId: binding.accountId,
      peerId: binding.peerId,
      threadId: binding.threadId,
    });
  }
  return output;
}

export function normalizeAppModelRef(value?: string): `${string}/${string}` {
  const trimmed = value?.trim();
  if (trimmed && trimmed.includes("/")) return trimmed as `${string}/${string}`;
  if (trimmed) return `openai/${trimmed}`;
  return DEFAULT_MODEL_REF;
}

export function timestampBefore(candidate: string, reference: string): boolean {
  const candidateMs = Date.parse(candidate);
  const referenceMs = Date.parse(reference);
  return Number.isFinite(candidateMs) && Number.isFinite(referenceMs) &&
    candidateMs < referenceMs;
}

function safeSkillNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    const name = safeOptionalShortToken(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.slice(0, 48);
}
