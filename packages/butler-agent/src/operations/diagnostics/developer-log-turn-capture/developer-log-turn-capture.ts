import { join } from "node:path";
import { DeveloperLogStore, type DeveloperLogSection } from "../developer-log-store.ts";
import { readDeveloperDiagnosticsEnabled } from "../developer-log-settings.ts";
import type { ModelRoundRequest, ModelRoundResult } from "../../../agent/btcc/ports/model-round.ts";
import type { TurnDeveloperLogCapturePort } from "./contracts.ts";
import { safeRuntimeFailure, type RuntimeFailureDiagnostic } from "../../../integrations/providers/provider-errors.ts";
import {
  inboundEnvelopeFromTurnRecord,
  storedBindingFromTurnRecord,
} from "./turn-record-capture-adapter.ts";

/** App settings database backing AppSettingsPersistence, relative to Butler data. */
const APP_SETTINGS_DB_RELATIVE_PATH = join("app-server", "butler-client.sqlite");

export function createNoopTurnDeveloperLogCapturePort(): TurnDeveloperLogCapturePort {
  return { startExecution: () => ({ capture() {} }) };
}

/**
 * Developer-log capture port backed by the real DeveloperLogStore.
 *
 * The gate runs on every capture call so a settings toggle takes effect on
 * the next turn without a restart; every capture error is swallowed because
 * developer diagnostics must never affect the user turn.
 */
export function createTurnDeveloperLogCapturePort(input: {
  store: DeveloperLogStore;
  gate: () => boolean;
}): TurnDeveloperLogCapturePort {
  function enabled(): boolean {
    try { return input.gate() === true; } catch { return false; }
  }
  return {
    startExecution() {
      let request: ReturnType<typeof requestSnapshot> | undefined;
      let response: ModelRoundResult | undefined;
      let failure: RuntimeFailureDiagnostic | undefined;
      let roundCount = 0;
      return {
        modelRoundObserver: {
          request(value) {
            roundCount += 1;
            request = undefined;
            response = undefined;
            failure = undefined;
            if (!enabled()) return;
            try { request = requestSnapshot(value); } catch { /* Never affect the model request. */ }
          },
          response(value) {
            if (!request || !enabled()) return;
            try { response = structuredClone(value); } catch { /* Unavailable, not invented raw data. */ }
          },
          failure(error) {
            if (!request || !enabled()) return;
            try { failure = safeRuntimeFailure(error); } catch { /* Never affect recovery. */ }
          },
        },
        capture(capture) {
          try {
            if (!enabled()) return;
            const shared = {
              binding: storedBindingFromTurnRecord(capture.turn, capture.timestamp),
              envelope: inboundEnvelopeFromTurnRecord(capture.turn, capture.timestamp),
              contextSections: request?.sections,
              metadata: {
                capture_scope: "last_provider_round",
                provider_round_count: roundCount,
                effective_model_ref: request?.model ?? null,
                round_id: request?.roundId ?? null,
                request_available: Boolean(request),
                response_format: !response ? "unavailable" : response.raw === undefined ? "normalized" : "provider_raw",
                ...(request?.metadata ?? {}),
              },
              timestamp: capture.timestamp,
            };
            const raw = response?.raw ?? (response ? {
              text: response.text, toolCalls: response.toolCalls,
              usage: response.usage, providerIdentity: response.providerIdentity,
            } : null);
            if (capture.kind === "model_turn") {
              input.store.appendModelTurn({ ...shared, result: { text: capture.result.content, raw } });
            } else {
              input.store.appendModelTurnError({
                ...shared, kind: "model_turn_error", failure: failure ?? capture.failure,
                diagnostics: { ...capture.diagnostics, provider_response: raw },
              });
            }
          } catch {
            // Store/settings failures must never change the canonical turn outcome.
          } finally {
            request = undefined;
            response = undefined;
            failure = undefined;
          }
        },
      };
    },
  };
}

/**
 * Default per-call gate reading developer diagnostics from the app settings
 * database under `<butlerData>/app-server/butler-client.sqlite`.
 */
export function createDefaultDeveloperDiagnosticsGate(
  butlerData: string,
): () => boolean {
  return () => readDeveloperDiagnosticsEnabled({
    dbPath: join(butlerData, APP_SETTINGS_DB_RELATIVE_PATH),
  });
}

/** Textual provider-port inputs only; never credentials, callbacks or image bytes. */
function requestSnapshot(request: ModelRoundRequest) {
  const sections: DeveloperLogSection[] = [];
  const add = (id: string, title: string, content: string) => {
    sections.push({ id, title, region: "unknown", content, char_count: content.length });
  };
  if (request.instructions) add("instructions", "instructions", request.instructions);
  request.messages.forEach((message, index) => {
    add(`message-${index}`, `${message.role}${message.requestSegmentKind ? ` · ${message.requestSegmentKind}` : ""}`,
      JSON.stringify({ role: message.role, content: message.content, name: message.name,
        toolCallId: message.toolCallId, toolCalls: message.toolCalls }));
  });
  add("tools", "tools", JSON.stringify(request.tools));
  return {
    model: request.model, roundId: request.roundId, sections,
    metadata: { reasoning_effort: request.reasoningEffort ?? null },
  };
}
