import { useEffect, useRef, useState } from "react";
import { onboardingCompletedPatch } from "@/app/onboarding.ts";
import { commitConnection, type PendingConnection } from "@/app/setupConnection.ts";
import type { SetupReadinessStatus } from "@/app/setupReadiness.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";

/**
 * Finishes the first run once a choice is made: it waits for Butler to be
 * ready, then registers the model, makes it the default and records
 * onboarding (consent time and completion) in the agent.
 */
export function useConnectionCommit({ readinessStatus, acceptedAt, language, onDone }: {
  readinessStatus: SetupReadinessStatus;
  acceptedAt: string | null;
  language: SettingsView["language"];
  onDone: (connection: PendingConnection, model: AppModelSummary) => void;
}) {
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [committing, setCommitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    if (!pending || failed || inFlight.current || readinessStatus !== "ready") return;
    inFlight.current = true;
    setCommitting(true);
    const now = new Date().toISOString();
    commitConnection({
      connection: pending,
      language,
      onboarding: (current) => onboardingCompletedPatch(current, acceptedAt ?? now, now).onboarding,
    }).then((result) => {
      useButlerStore.getState().setModelCatalog(result.catalog);
      useButlerStore.getState().setSettings(result.settings);
      if (mounted.current) done.current(pending, result.model);
    }).catch(() => {
      if (mounted.current) setFailed(true);
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setCommitting(false);
    });
  }, [acceptedAt, failed, language, pending, readinessStatus]);

  return {
    pending,
    committing,
    failed,
    /** A choice is made but Butler is still getting ready. */
    waitingForReady: Boolean(pending) && readinessStatus !== "ready",
    submit: (connection: PendingConnection) => {
      setFailed(false);
      setPending(connection);
    },
    retry: () => setFailed(false),
    clear: () => {
      setFailed(false);
      setPending(null);
    },
  };
}
