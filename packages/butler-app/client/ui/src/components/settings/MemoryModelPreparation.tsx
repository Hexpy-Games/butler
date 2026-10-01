import { useEffect, useState } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { fetchSetupReadiness, retrySetupReadiness } from "@/app/setupConnection.ts";
import type { SetupReadinessView } from "@/app/setupReadiness.ts";
import { MemoryModelStatus } from "../first-run/MemoryModelStatus";

export function MemoryModelPreparation() {
  const language = useAppLocale();
  const [view, setView] = useState<SetupReadinessView | null>(null);
  const settled = view?.memory_model?.state === "ready" || view?.memory_model?.state === "failed";
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
  return <MemoryModelStatus model={view?.memory_model} language={language} retry={() => {
    void retrySetupReadiness(true).then(setView).catch(() => setView(null));
  }} />;
}
