import {
  modelCatalogGeneration,
  listModelMetadata,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import type { ModelRef } from "../../../core/contracts.ts";
import type { TurnControlResolution } from "../../../core/turn-execution-controls.ts";
import type {
  SessionControlState,
  SessionControlsView,
  SettingsView,
} from "../../interface/protocol/app-protocol.ts";
import { safeLocalSessionId } from "./session-read-model.ts";
import { normalizeSessionControls } from "../settings/settings-models.ts";
import type { AppSettingsPersistence } from "../settings/settings-persistence.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

export function sessionControlsKey(sessionId: string): string {
  return `session-controls:${safeLocalSessionId(sessionId)}`;
}

function sessionControlsExplicitKey(sessionId: string): string {
  return `session-controls-explicit:${safeLocalSessionId(sessionId)}`;
}

function sessionControlsRevisionKey(sessionId: string): string {
  return `session-controls-revision:${safeLocalSessionId(sessionId)}`;
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
      revision: this.revision(sessionId),
      catalog_generation: modelCatalogGeneration(this.availableModels()),
    };
  }

  updateView(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlsView {
    this.ensureChat(sessionId);
    const controls = this.update(sessionId, input);
    return this.getViewWithControls(sessionId, controls);
  }

  get(sessionId: string): SessionControlState {
    const settings = this.getSettings();
    const stored = this.hasExplicit(sessionId)
      ? this.persistence.read<Partial<SessionControlState>>(
          sessionControlsKey(sessionId),
        ) ?? {}
      : {};
    const candidate = {
      model: stored.model ?? settings.model,
      reasoning_effort: stored.reasoning_effort ?? settings.reasoning_effort,
      access_mode: stored.access_mode ?? settings.access_mode,
      plan_mode: stored.plan_mode ?? settings.plan_mode_default,
    };
    const registered = this.availableModels();
    if (
      this.hasExplicit(sessionId) &&
      typeof stored.model === "string" &&
      registered.length > 0 &&
      !selectableModel(registered, stored.model)
    ) {
      const normalizedFallback = normalizeSessionControls(
        { ...candidate, model: settings.model },
        registered,
      );
      return {
        ...normalizedFallback,
        model: stored.model,
        reasoning_effort:
          stored.reasoning_effort ?? normalizedFallback.reasoning_effort,
      };
    }
    return normalizeSessionControls(
      candidate,
      registered,
    );
  }

  update(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState {
    const registered = this.availableModels();
    const merged = { ...this.get(sessionId), ...input };
    this.assertModelAvailable(merged.model, registered);
    const next = normalizeSessionControls(merged, registered);
    this.persistence.write(sessionControlsKey(sessionId), next);
    this.persistence.write(sessionControlsExplicitKey(sessionId), true);
    const revision = this.revision(sessionId) + 1;
    this.persistence.write(sessionControlsRevisionKey(sessionId), revision);
    this.appendEvent("session.controls_updated", {
      session_id: sessionId,
      model: next.model,
      reasoning_effort: next.reasoning_effort,
      access_mode: next.access_mode,
      plan_mode: next.plan_mode,
      revision,
      catalog_generation: modelCatalogGeneration(registered),
    });
    return next;
  }

  controlsForMessageSend(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState {
    return this.resolveForMessageSend(sessionId, input).controls;
  }

  resolveForMessageSend(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): TurnControlResolution {
    const messageOverride = hasSessionControlInput(input);
    const controls = messageOverride
      ? this.update(sessionId, input)
      : this.get(sessionId);
    const registered = this.availableModels();
    this.assertModelAvailable(controls.model, registered);
    return {
      controls: {
        ...controls,
        model: controls.model as ModelRef,
      },
      source: messageOverride
        ? "message_override"
        : this.hasExplicit(sessionId)
          ? "session_override"
          : "global_default",
      sessionControlRevision: this.revision(sessionId),
      catalogGeneration: modelCatalogGeneration(registered),
    };
  }

  hasExplicit(sessionId: string): boolean {
    return this.persistence.read<boolean>(sessionControlsExplicitKey(sessionId)) === true;
  }

  revision(sessionId: string): number {
    const value = this.persistence.read<number>(sessionControlsRevisionKey(sessionId));
    return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
  }

  private getViewWithControls(
    sessionId: string,
    controls: SessionControlState,
  ): SessionControlsView {
    return {
      session_id: sessionId,
      controls,
      revision: this.revision(sessionId),
      catalog_generation: modelCatalogGeneration(this.availableModels()),
    };
  }

  private assertModelAvailable(
    modelRef: string,
    registered: ProviderModelMetadata[],
  ): void {
    if (selectableModel(registered, modelRef)) return;
    throw new AppStoreOperationError(
      409,
      "session_model_unavailable",
      `The selected model is no longer available: ${modelRef}`,
    );
  }

  private availableModels(): ProviderModelMetadata[] {
    const registered = this.registeredModelMetadata();
    return registered.length > 0 ? registered : listModelMetadata();
  }
}

function selectableModel(
  models: readonly ProviderModelMetadata[],
  modelRef: string,
): ProviderModelMetadata | undefined {
  const value = modelRef.trim();
  return models.find(
    (model) =>
      model.runtime_supported &&
      (model.model_ref === value || model.model_id === value),
  );
}
