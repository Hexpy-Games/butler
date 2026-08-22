import { join } from "node:path";
import { DeveloperLogStore } from "../developer-log-store.ts";
import { readDeveloperDiagnosticsEnabled } from "../developer-log-settings.ts";
import type {
  BtccAgentLoopResult,
} from "../../../agent/btcc/agent-loop/index.ts";
import type { TurnDeveloperLogCapturePort } from "./contracts.ts";
import {
  inboundEnvelopeFromTurnRecord,
  storedBindingFromTurnRecord,
} from "./turn-record-capture-adapter.ts";

/** App settings database backing AppSettingsPersistence, relative to Butler data. */
const APP_SETTINGS_DB_RELATIVE_PATH = join("app-server", "butler-client.sqlite");

export function createNoopTurnDeveloperLogCapturePort(): TurnDeveloperLogCapturePort {
  return { capture() {} };
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
  return {
    capture(capture) {
      try {
        if (input.gate() !== true) return;
        if (capture.kind === "model_turn") {
          input.store.appendModelTurn({
            kind: "model_turn",
            binding: storedBindingFromTurnRecord(capture.turn, capture.timestamp),
            envelope: inboundEnvelopeFromTurnRecord(
              capture.turn,
              capture.timestamp,
            ),
            result: {
              text: capture.result.content,
              raw: modelTurnRawPayload(capture.result),
            },
            timestamp: capture.timestamp,
          });
          return;
        }
        input.store.appendModelTurnError({
          kind: "model_turn_error",
          binding: storedBindingFromTurnRecord(capture.turn, capture.timestamp),
          envelope: inboundEnvelopeFromTurnRecord(
            capture.turn,
            capture.timestamp,
          ),
          failure: capture.failure,
          diagnostics: capture.diagnostics,
          timestamp: capture.timestamp,
        });
      } catch {
        // Fail-open for logging: diagnostics never veto the turn outcome.
      }
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

function modelTurnRawPayload(
  result: BtccAgentLoopResult,
): Record<string, unknown> {
  return {
    route: result.route,
    workStatus: result.workStatus ?? null,
    terminalOutcome: result.terminalOutcome ?? null,
  };
}
