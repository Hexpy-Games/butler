import {
  ingestTaskOutcomeMemory,
  updateExplicitMemory,
} from "../../cognition/memory/quality.ts";
import type { VectorEpisodeBackend } from "../../cognition/memory/recall/vector.ts";
import { queryMemory } from "../../cognition/memory/exact-query.ts";
import { readReflectiveProfileSummary, type ProfilingMode } from "../../../personalization/profiling.ts";
import {
  readConversationContext,
  type ConversationContextDirection,
} from "../../context/conversation-context.ts";
import {
  updateFirstChatOnboarding,
  type FirstChatOnboardingPersonaPreset,
} from "../../../personalization/onboarding.ts";

type ToolCall = { args: Record<string, unknown> };

export function createMemoryToolHandlers(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  sessionId?: string;
  projectId?: string;
  memoryVectorBackend?: VectorEpisodeBackend;
  memoryVectorTimeoutMs?: number;
}) {
  return {
    "ingest_task_memory": async (call: ToolCall) => {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) throw new Error("ingest_task_memory requires task_id");
      return ingestTaskOutcomeMemory({
        butlerData: input.butlerData,
        taskId,
      });
    },
    "query_memory": async (call: ToolCall) => {
      const scope = call.args.scope === "session" ? "session" : "all_sessions";
      const sessionId = typeof call.args.session_id === "string" && call.args.session_id.trim()
        ? call.args.session_id.trim()
        : input.sessionId;
      return {
        ok: true,
        ...queryMemory({
          butlerData: input.butlerData,
          appMessageDbPath: input.appMessageDbPath,
          query: typeof call.args.query === "string" ? call.args.query : undefined,
          scope,
          sessionId,
          speaker: call.args.speaker === "user" || call.args.speaker === "butler" ? call.args.speaker : "any",
          eventKind: call.args.event_kind === "inbound" || call.args.event_kind === "outbound"
            ? call.args.event_kind
            : "any",
          order: call.args.order === "latest" ? "latest" : "earliest",
          matchMode: call.args.match_mode === "all" || call.args.match_mode === "phrase"
            ? call.args.match_mode
            : "any",
          limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
          dateFrom: typeof call.args.date_from === "string" ? call.args.date_from : undefined,
          dateTo: typeof call.args.date_to === "string" ? call.args.date_to : undefined,
          includeInternal: call.args.include_internal === true,
          includePlaceholders: call.args.include_placeholders === true,
          includeTranscriptRecovery: call.args.include_transcript_recovery === true,
        }),
      };
    },
    "summarize_user_profile": async (call: ToolCall) => {
      const locale = call.args.locale === "en" ? "en" : "ko";
      return readReflectiveProfileSummary(input.butlerData, locale);
    },
    "update_onboarding_profile": async (call: ToolCall) => {
      const personaPreset = onboardingPersonaPreset(call.args.persona_preset);
      const profilingMode = onboardingProfilingMode(call.args.profiling_mode);
      return updateFirstChatOnboarding(input.butlerData, {
        principal_name: optionalToolString(call.args.principal_name),
        preferred_address: optionalToolString(call.args.preferred_address),
        butler_nickname: optionalToolString(call.args.butler_nickname),
        interests: optionalToolString(call.args.interests),
        work: optionalToolString(call.args.work),
        service_preference: optionalToolString(call.args.service_preference),
        persona_preset: personaPreset,
        persona_custom: optionalToolString(call.args.persona_custom),
        profiling_mode: profilingMode,
        skipped_fields: Array.isArray(call.args.skipped_fields)
          ? call.args.skipped_fields.filter((item): item is string => typeof item === "string")
          : undefined,
        complete: call.args.complete === true,
        locale: call.args.locale === "en" ? "en" : "ko",
        butlerHome: input.butlerHome,
      });
    },
    "read_conversation_context": async (call: ToolCall) => {
      const direction = call.args.direction === "before" ||
        call.args.direction === "after" ||
        call.args.direction === "around"
        ? call.args.direction as ConversationContextDirection
        : undefined;
      return readConversationContext({
        sessionId: input.sessionId ?? "butler/main",
        butlerData: input.butlerData,
        query: typeof call.args.query === "string" ? call.args.query : undefined,
        anchorMessageId: typeof call.args.anchor_message_id === "string"
          ? call.args.anchor_message_id
          : undefined,
        anchorEventId: typeof call.args.anchor_event_id === "string"
          ? call.args.anchor_event_id
          : undefined,
        direction,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
        maxChars: typeof call.args.max_chars === "number" ? call.args.max_chars : undefined,
        includeTools: call.args.include_tools === true,
      });
    },
    "update_explicit_memory": async (call: ToolCall) => {
      const kind = typeof call.args.kind === "string" ? call.args.kind.trim() : "";
      if (kind !== "rule") {
        throw new Error("update_explicit_memory requires kind rule");
      }
      const text = typeof call.args.text === "string" ? call.args.text.trim() : "";
      const source = typeof call.args.source === "string" ? call.args.source.trim() : "";
      if (!text) throw new Error("update_explicit_memory requires text");
      if (!source) throw new Error("update_explicit_memory requires source");
      return updateExplicitMemory({
        butlerData: input.butlerData,
        update: {
          kind,
          text,
          source,
        },
      });
    },
  };
}

function optionalToolString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function onboardingPersonaPreset(value: unknown): FirstChatOnboardingPersonaPreset | "custom" | undefined {
  if (value === "custom") return "custom";
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function onboardingProfilingMode(value: unknown): ProfilingMode | undefined {
  return value === "off" || value === "basic" || value === "deep" ? value : undefined;
}
