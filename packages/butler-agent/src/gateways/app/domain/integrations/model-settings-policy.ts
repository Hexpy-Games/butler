import { Database } from "bun:sqlite";
import type { ProviderModelMetadata } from "../../../../integrations/providers/model-catalog.ts";
import type { SettingRow } from "../../infrastructure/core/records.ts";
import type { SessionControlState, SettingsView } from "../../interface/protocol/app-protocol.ts";
import type { AppSettingsPersistence } from "../settings/settings-persistence.ts";
import { normalizeSessionControls, rewriteSettingsModelRefs } from "../settings/settings-models.ts";
import { sessionControlsKey } from "../sessions/session-controls-store.ts";

export class AppModelSettingsPolicy {
  constructor(
    private readonly db: Database,
    private readonly persistence: AppSettingsPersistence,
    private readonly getSettings: () => SettingsView,
    private readonly registeredModelMetadata: () => ProviderModelMetadata[],
  ) {}

  hasActiveTurnUsingModel(modelRef: string): boolean {
    const rows = this.db
      .query<{ chat_id: string }, []>(
        `
      SELECT DISTINCT chat_id
      FROM turns
      WHERE state IN ('queued', 'accepted', 'thinking', 'streaming', 'waiting_for_form', 'waiting_for_tool', 'retrying', 'cancelling')
    `,
      )
      .all();
    if (rows.length === 0) return false;
    const settings = this.getSettings();
    const registeredModels = this.registeredModelMetadata();
    for (const row of rows) {
      const stored = this.persistence.read<Partial<SessionControlState>>(
        sessionControlsKey(row.chat_id),
      );
      const controls = normalizeSessionControls(
        {
          model: stored?.model ?? settings.model,
          reasoning_effort:
            stored?.reasoning_effort ?? settings.reasoning_effort,
          access_mode: stored?.access_mode ?? settings.access_mode,
          plan_mode: stored?.plan_mode ?? settings.plan_mode_default,
        },
        registeredModels,
      );
      if (controls.model === modelRef) return true;
    }
    return false;
  }

  rewriteStoredModelRefs(previousModelRef: string, nextModelRef: string): void {
    const storedSettings = this.persistence.read<Partial<SettingsView>>(
      "settings",
    );
    if (storedSettings) {
      this.persistence.write(
        "settings",
        rewriteSettingsModelRefs(
          storedSettings,
          previousModelRef,
          nextModelRef,
        ),
      );
    }

    const rows = this.db
      .query<SettingRow, []>(
        `
      SELECT key, value_json
      FROM app_settings
      WHERE key LIKE 'session-controls:%'
    `,
      )
      .all();
    for (const row of rows) {
      let parsed: Partial<SessionControlState>;
      try {
        parsed = JSON.parse(row.value_json) as Partial<SessionControlState>;
      } catch {
        continue;
      }
      if (parsed.model !== previousModelRef) continue;
      this.persistence.write(row.key, {
        ...parsed,
        model: nextModelRef,
      });
    }
  }

  normalizeStoredModelSettings(): void {
    this.persistence.write("settings", this.getSettings());
    const registeredModels = this.registeredModelMetadata();
    const rows = this.db
      .query<SettingRow, []>(
        `
      SELECT key, value_json
      FROM app_settings
      WHERE key LIKE 'session-controls:%'
    `,
      )
      .all();
    for (const row of rows) {
      let parsed: Partial<SessionControlState>;
      try {
        parsed = JSON.parse(row.value_json) as Partial<SessionControlState>;
      } catch {
        continue;
      }
      this.persistence.write(
        row.key,
        normalizeSessionControls(parsed, registeredModels),
      );
    }
  }
}
