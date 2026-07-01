import type { ProviderModelMetadata } from "../../../../integrations/providers/model-catalog.ts";
import type {
  SessionControlState,
  SessionControlsView,
  SettingsView,
} from "../../interface/protocol/app-protocol.ts";
import { safeLocalSessionId } from "./session-read-model.ts";
import { normalizeSessionControls } from "../settings/settings-models.ts";
import type { AppSettingsPersistence } from "../settings/settings-persistence.ts";

export function sessionControlsKey(sessionId: string): string {
  return `session-controls:${safeLocalSessionId(sessionId)}`;
}

function sessionControlsExplicitKey(sessionId: string): string {
  return `session-controls-explicit:${safeLocalSessionId(sessionId)}`;
}

function hasSessionControlInput(input: Partial<SessionControlState>): boolean {
  return (
    input.model !== undefined ||
    input.reasoning_effort !== undefined ||
    input.access_mode !== undefined ||
    input.plan_mode !== undefined
  );
}

export class AppSessionControlsStore {
  constructor(
    private readonly persistence: AppSettingsPersistence,
    private readonly getSettings: () => SettingsView,
    private readonly registeredModelMetadata: () => ProviderModelMetadata[],
    private readonly ensureChat: (sessionId: string) => void,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {}

  getView(sessionId: string): SessionControlsView {
    this.ensureChat(sessionId);
    return {
      session_id: sessionId,
      controls: this.get(sessionId),
    };
  }

  updateView(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlsView {
    this.ensureChat(sessionId);
    return {
      session_id: sessionId,
      controls: this.update(sessionId, input),
    };
  }

  get(sessionId: string): SessionControlState {
    const settings = this.getSettings();
    const stored = this.hasExplicit(sessionId)
      ? this.persistence.read<Partial<SessionControlState>>(
          sessionControlsKey(sessionId),
        ) ?? {}
      : {};
    return normalizeSessionControls(
      {
        model: stored.model ?? settings.model,
        reasoning_effort: stored.reasoning_effort ?? settings.reasoning_effort,
        access_mode: stored.access_mode ?? settings.access_mode,
        plan_mode: stored.plan_mode ?? settings.plan_mode_default,
      },
      this.registeredModelMetadata(),
    );
  }

  update(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState {
    const next = normalizeSessionControls(
      { ...this.get(sessionId), ...input },
      this.registeredModelMetadata(),
    );
    this.persistence.write(sessionControlsKey(sessionId), next);
    this.persistence.write(sessionControlsExplicitKey(sessionId), true);
    this.appendEvent("session.controls_updated", {
      session_id: sessionId,
      model: next.model,
      reasoning_effort: next.reasoning_effort,
      access_mode: next.access_mode,
      plan_mode: next.plan_mode,
    });
    return next;
  }

  controlsForMessageSend(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState {
    return hasSessionControlInput(input) ? this.update(sessionId, input) : this.get(sessionId);
  }

  hasExplicit(sessionId: string): boolean {
    return this.persistence.read<boolean>(sessionControlsExplicitKey(sessionId)) === true;
  }
}
