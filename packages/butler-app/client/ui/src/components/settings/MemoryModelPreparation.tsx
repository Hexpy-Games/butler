import { useEffect, useState } from "react";
import { SettingsField, Switch, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { chooseMemoryModel, fetchSetupReadiness, retrySetupReadiness } from "@/app/setupConnection.ts";
import { memoryModelChoice, memoryModelSettled, type SetupReadinessView } from "@/app/setupReadiness.ts";
import { MemoryModelStatus } from "../first-run/MemoryModelStatus";

/** Settings → Memory: the same memory-model choice as the first run, with its download status. */
export function MemoryModelPreparation() {
  const language = useAppLocale();
  const [view, setView] = useState<SetupReadinessView | null>(null);
  const [saving, setSaving] = useState(false);
  const model = view?.memory_model;
  const settled = Boolean(view) && memoryModelSettled(model);
  useEffect(() => {
    if (settled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await fetchSetupReadiness(); if (!cancelled && next !== "unsupported") setView(next); } catch { /* Reconnect on the next read. */ }
      if (!cancelled) timer = setTimeout(() => void poll(), 800);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [settled]);
  const copy = appCopy.firstRun;
  const sizeMB = model && model.bytes_total > 0 && model.state !== "ready" ? Math.round(model.bytes_total / 1_000_000) : undefined;
  const choose = (enabled: boolean) => {
    setSaving(true);
    chooseMemoryModel(enabled).then(setView)
      .catch((error: unknown) => notifyError(error, copy.memoryChoice.saveFailed, { id: "memory-model-choice" }))
      .finally(() => setSaving(false));
  };
  return (
    <SettingsField settingId="memory-model" label={copy.memoryChoice.on} description={copy.memoryModel.description(sizeMB)}
      control={<Switch aria-label={copy.memoryChoice.on} checked={memoryModelChoice(model) === "on"} disabled={!model || saving} onCheckedChange={choose} />}
      meta={<>
        {model?.state === "ready" ? <Typo.Caption role="status" tone="success">{copy.memoryModel.ready}</Typo.Caption> : null}
        <MemoryModelStatus model={model} language={language} retry={() => {
          void retrySetupReadiness(true).then(setView).catch(() => setView(null));
        }} />
      </>} />
  );
}
