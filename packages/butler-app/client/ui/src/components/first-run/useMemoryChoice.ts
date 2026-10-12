import { useState } from "react";
import { notifyError } from "@/app/notifications.ts";
import { memoryModelChoice } from "@/app/setupReadiness.ts";
import type { SetupReadinessController } from "./useSetupReadiness";

export type MemoryChoice = "on" | "off";

/** First-run memory step: a required pick; Continue saves it and only on starts the download. */
export function useMemoryChoice({ setup, saveFailed, onSaved }: {
  setup: SetupReadinessController;
  saveFailed: string;
  onSaved: () => void;
}) {
  const [picked, setPicked] = useState<MemoryChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const model = setup.readiness.memory_model;
  const value = picked ?? memoryModelChoice(model);
  async function save(): Promise<void> {
    if (!value || saving) return;
    setSaving(true);
    try {
      await setup.chooseModel(value === "on");
      onSaved();
    } catch (error) {
      notifyError(error, saveFailed, { id: "first-run-memory" });
    } finally {
      setSaving(false);
    }
  }
  return {
    value,
    saving,
    /** The agent answers readiness before a choice can be saved. */
    available: Boolean(model),
    sizeMB: model && model.bytes_total > 0 ? Math.round(model.bytes_total / 1_000_000) : undefined,
    pick: setPicked,
    save: () => void save(),
  };
}
