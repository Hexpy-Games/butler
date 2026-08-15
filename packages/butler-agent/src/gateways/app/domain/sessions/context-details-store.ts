import { readCompactionSnapshots } from "../../../../agent/context/compaction.ts";
import {
  evaluateWorkingContextBudget,
  resolveContextBudgetConfig,
  WORKING_CONTEXT_AUTO_COMPACT_RATIO,
  WORKING_CONTEXT_HARD_PRESSURE_RATIO,
} from "../../../../agent/context/budget.ts";
import {
  resolveModelMetadata,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import { contextWindowTokensForSessionModel } from "../settings/settings-models.ts";
import {
  contextCategory,
  isReservedContextCategory,
  latestLivePromptUsage,
  reconcileOccupiedCategoryTokens,
} from "./context-details-read-model.ts";
import { sessionHintForRow } from "./session-read-model.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import type {
  ContextDetailsView,
  MessageRecord,
  PersonalizationView,
  SessionArtifactSummary,
  SessionControlState,
  SettingsView,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";

/**
 * Context details only uses the latest user message and a small conversation
 * suffix for its estimate. Keep this read path materially below the public
 * session-view page so provider/tool output cannot make a polling request
 * materialize the whole bounded transcript window.
 */
export const CONTEXT_DETAILS_MESSAGE_WINDOW_LIMIT = 16;
export const CONTEXT_DETAILS_MAX_RECENT_CONVERSATION_CHARS = 32_000;
export const MAX_CONTEXT_DETAILS_CACHE_ENTRIES = 8;

interface ContextDetailsCacheEntry {
  revision: string;
  value: ContextDetailsView;
}

export class AppContextDetailsStore {
  private readonly contextDetailsCache = new Map<
    string,
    ContextDetailsCacheEntry
  >();

  constructor(
    private readonly butlerData: string,
    private readonly messageFiles: AppMessageFileStore,
    private readonly ensureChat: (sessionId: string) => void,
    private readonly contextDetailsRevision: (sessionId: string) => string,
    private readonly getSessionControls: (
      sessionId: string,
    ) => SessionControlState,
    private readonly registeredModelMetadata: () => ProviderModelMetadata[],
    private readonly getSettings: () => SettingsView,
    private readonly getPersonalization: () => PersonalizationView,
    private readonly sessionViewMessages: (
      sessionId: string,
      options?: { limit?: number },
    ) => MessageRecord[],
    private readonly latestTurn: (sessionId: string) => TurnRecord | null,
    private readonly countTurns: (sessionId: string) => number,
    private readonly getProjectForSession: (
      sessionId: string,
    ) => ProjectRow | null,
    private readonly chatKindForSession: (sessionId: string) => string,
    private readonly listArtifacts: (
      sessionId: string,
    ) => SessionArtifactSummary[],
  ) {}

  getContextDetails(sessionId: string): ContextDetailsView {
    this.ensureChat(sessionId);
    const revision = this.contextDetailsRevision(sessionId);
    const cached = this.contextDetailsCache.get(sessionId);
    if (cached?.revision === revision) {
      this.contextDetailsCache.delete(sessionId);
      this.contextDetailsCache.set(sessionId, cached);
      return {
        ...cached.value,
        updated_at: new Date().toISOString(),
      };
    }
    const controls = this.getSessionControls(sessionId);
    const registeredModels = this.registeredModelMetadata();
    const metadata = resolveModelMetadata(
      controls.model,
      registeredModels,
    );
    const settings = this.getSettings();
    const sessionContextWindowTokens = contextWindowTokensForSessionModel(
      settings,
      metadata,
    );
    const budgetConfig = resolveContextBudgetConfig(metadata.model_ref, {
      contextWindowTokens: sessionContextWindowTokens,
    });
    const personalization = this.getPersonalization();
    const runtimeSessionId = sessionHintForRow(sessionId);
    const latestTurn = this.latestTurn(sessionId);
    const project = this.getProjectForSession(sessionId);
    const messageFileCount = this.messageFiles.countForSession(sessionId);
    const messages = this.sessionViewMessages(sessionId, {
      limit: CONTEXT_DETAILS_MESSAGE_WINDOW_LIMIT,
    });
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    const livePromptUsage = latestLivePromptUsage({
      butlerData: this.butlerData,
      runtimeSessionId,
      turnId: latestTurn?.id,
      latestTurnStartedAt: latestTurn?.created_at,
      currentModelRef: metadata.model_ref,
    });
    const staticContextTokens = estimateDiagnosticTokens(
      "Butler runtime contract, role policy, transport contract, and safety rules.",
    ).tokens;
    const liveConfigurationTokens = estimateDiagnosticTokens(
      JSON.stringify({
        language: settings.language,
        persona: personalization.persona ? "configured" : "empty",
        eol: personalization.eol ? "configured" : "empty",
        model: metadata.model_ref,
        access_mode: controls.access_mode,
        plan_mode: controls.plan_mode,
      }),
    ).tokens;
    const runtimeStateTokens = estimateDiagnosticTokens(
      JSON.stringify({
        runtimeSessionId,
        projectId: project?.id ?? null,
        sessionKind: this.chatKindForSession(sessionId),
        turnCount: this.countTurns(sessionId),
      }),
    ).tokens;
    const currentInputTokens = estimateBoundedDiagnosticTokens(
      latestUserMessage?.text ?? "",
    );
    // A provider usage sample is authoritative for the working-context
    // total, so do not re-tokenize the recent transcript on every polling
    // request. When no sample exists, cap the fallback material by bytes so
    // one provider/tool message cannot make this diagnostic path retain a
    // large transient string or tokenizer output.
    const recentConversationTokens = livePromptUsage
      ? 0
      : estimateBoundedDiagnosticTokens(
          boundedRecentConversationText(messages),
        );
    const latestCompaction = [
      ...readCompactionSnapshots({
        butlerData: this.butlerData,
        sessionId: runtimeSessionId,
      }),
    ]
      .reverse()
      .find((snapshot) => snapshot.status === "ok");
    const retrievedContextTokens = estimateBoundedDiagnosticTokens(
      latestCompaction?.summary ?? "",
    );
    const artifacts = this.listArtifacts(sessionId);
    const referenceTokens = Math.max(
      0,
      artifacts.length * 48 + messageFileCount * 24,
    );
    const knownPromptTokens =
      staticContextTokens +
      liveConfigurationTokens +
      runtimeStateTokens +
      retrievedContextTokens +
      currentInputTokens +
      referenceTokens;
    const measuredWorkingContextTokens = livePromptUsage
      ? Math.max(0, livePromptUsage.promptTokens - knownPromptTokens)
      : 0;
    const workingContextTokens = livePromptUsage
      ? measuredWorkingContextTokens
      : recentConversationTokens;
    const workingBudget = evaluateWorkingContextBudget({
      modelRef: metadata.model_ref,
      staticContextTokens,
      liveConfigurationTokens,
      runtimeStateTokens,
      workingContextTokens:
        workingContextTokens +
        retrievedContextTokens +
        currentInputTokens +
        referenceTokens,
      overrides: {
        contextWindowTokens: budgetConfig.contextWindowTokens,
      },
    });
    let categories = [
      contextCategory(
        "static",
        "Static Context",
        staticContextTokens,
        "static_context",
        budgetConfig.contextWindowTokens,
        "Stable runtime and role contract.",
      ),
      contextCategory(
        "live-config",
        "Live Configuration",
        liveConfigurationTokens,
        "live_configuration",
        budgetConfig.contextWindowTokens,
        "Latest EOL, persona, settings, rules, and profile projection.",
      ),
      contextCategory(
        "runtime-state",
        "Runtime State",
        runtimeStateTokens,
        "runtime_state",
        budgetConfig.contextWindowTokens,
        "Protected session, project, transport, BTCC, worker, and task state.",
      ),
      contextCategory(
        "working",
        "Working Context",
        workingContextTokens,
        "working_context",
        budgetConfig.contextWindowTokens,
        "Recent conversation suffix and current turn working material.",
      ),
      contextCategory(
        "retrieved",
        "Retrieved Context",
        retrievedContextTokens,
        "retrieved_context",
        budgetConfig.contextWindowTokens,
        "Hot cache, project memory, and latest compaction summary when present.",
      ),
      contextCategory(
        "current-input",
        "Current User Input",
        currentInputTokens,
        "current_input",
        budgetConfig.contextWindowTokens,
        "Latest inbound message and current attachment references.",
      ),
      contextCategory(
        "references",
        "References",
        referenceTokens,
        "references",
        budgetConfig.contextWindowTokens,
        `${artifacts.length + messageFileCount} stable local reference(s).`,
      ),
      contextCategory(
        "output-reserve",
        "Output Reserve",
        workingBudget.reservedOutputTokens,
        "output_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved for the assistant response.",
      ),
      contextCategory(
        "tool-reserve",
        "Tool Reserve",
        workingBudget.reservedToolTokens,
        "tool_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved for tool-call and tool-result growth.",
      ),
      contextCategory(
        "compaction-reserve",
        "Compaction Reserve",
        workingBudget.compactionPromptReserveTokens,
        "compaction_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved so auto-compaction can run before hard pressure.",
      ),
    ];
    if (livePromptUsage) {
      categories = reconcileOccupiedCategoryTokens(
        categories,
        livePromptUsage.promptTokens,
      );
    }
    const occupiedCategories = categories.filter(
      (category) => !isReservedContextCategory(category),
    );
    const used = livePromptUsage
      ? livePromptUsage.promptTokens
      : occupiedCategories.reduce((sum, item) => sum + item.used_tokens, 0);
    const value: ContextDetailsView = {
      session_id: sessionId,
      model_ref: metadata.model_ref,
      provider_id: metadata.provider_id,
      model_id: metadata.model_id,
      token_count_source: livePromptUsage?.source ?? "character_estimate",
      used_tokens: used,
      budget_tokens: budgetConfig.contextWindowTokens,
      max_output_tokens: metadata.max_output_tokens,
      available_working_context_tokens:
        workingBudget.availableWorkingContextTokens,
      used_working_context_tokens: workingBudget.workingContextTokens,
      usable_user_message_tokens: workingBudget.usableUserMessageTokens,
      auto_compact_at_tokens: Math.floor(
        workingBudget.availableWorkingContextTokens *
          WORKING_CONTEXT_AUTO_COMPACT_RATIO,
      ),
      hard_pressure_at_tokens: Math.floor(
        workingBudget.availableWorkingContextTokens *
          WORKING_CONTEXT_HARD_PRESSURE_RATIO,
      ),
      ratio: used / budgetConfig.contextWindowTokens,
      status:
        workingBudget.shouldHardPressure || workingBudget.shouldAutoCompact
          ? "high"
          : workingBudget.usedWorkingRatio >= 0.7
            ? "medium"
            : "low",
      categories,
      updated_at: new Date().toISOString(),
    };
    // Some settings/profile adapters repair a missing persisted projection on
    // their first read. Capture the post-computation revision so that repair
    // itself does not turn the immediately following poll into a false miss.
    const finalRevision = this.contextDetailsRevision(sessionId);
    this.contextDetailsCache.delete(sessionId);
    this.contextDetailsCache.set(sessionId, {
      revision: finalRevision,
      value,
    });
    while (this.contextDetailsCache.size > MAX_CONTEXT_DETAILS_CACHE_ENTRIES) {
      const oldest = this.contextDetailsCache.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.contextDetailsCache.delete(oldest);
    }
    return value;
  }
}

function boundedRecentConversationText(messages: readonly MessageRecord[]): string {
  const parts: string[] = [];
  let remaining = CONTEXT_DETAILS_MAX_RECENT_CONVERSATION_CHARS;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const prefix = `${message.role}: `;
    const text = message.text ?? "";
    const available = Math.max(0, remaining - prefix.length - 1);
    const suffix = text.length > available ? text.slice(-available) : text;
    const part = `${prefix}${suffix}`;
    parts.push(part);
    remaining -= part.length + 1;
  }
  return parts.reverse().join("\n");
}

/**
 * Diagnostic polling must not initialize or invoke a native provider
 * tokenizer. A four-character estimate is deliberately used for every local
 * section; provider prompt usage remains the authoritative exact sample when
 * it is available.
 */
function estimateDiagnosticTokens(
  textOrChars: string | number | null | undefined,
): { tokens: number; source: "character_estimate" } {
  const chars = typeof textOrChars === "number"
    ? textOrChars
    : (textOrChars ?? "").length;
  return {
    tokens: Math.max(0, Math.ceil(chars / 4)),
    source: "character_estimate",
  };
}

function estimateBoundedDiagnosticTokens(text: string): number {
  return estimateDiagnosticTokens(text).tokens;
}
