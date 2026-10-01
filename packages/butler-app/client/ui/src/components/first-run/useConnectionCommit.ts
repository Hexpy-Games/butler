import { api } from "@/app/api.ts";
import { connectionCardId, type FirstRunProviderCardId } from "@/app/setupProviders.ts";
import { useEffect, useRef, useState } from "react";
import { consentAcceptedPatch } from "@/app/onboarding.ts";
import { commitConnection, type PendingConnection } from "@/app/setupConnection.ts";
import type { SetupReadinessStatus } from "@/app/setupReadiness.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, SettingsView } from "@/app/types.ts";

/**
 * Waits for readiness, registers the chosen model and persists consent.
 * Reply-language confirmation owns onboarding completion.
 */
export function useConnectionCommit({ readinessStatus, acceptedAt, language, resume }: {
  readinessStatus: SetupReadinessStatus;
  acceptedAt: string | null;
  language: SettingsView["language"];
  resume: boolean;
}) {
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [committing, setCommitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [connected, setConnected] = useState<{ cardId: FirstRunProviderCardId; settings: SettingsView } | null>(null);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    if (!pending || connected || failed || inFlight.current || readinessStatus !== "ready") return;
    inFlight.current = true;
    setCommitting(true);
    const now = new Date().toISOString();
    commitConnection({
      connection: pending,
      language,
      onboarding: (current) => consentAcceptedPatch(current, acceptedAt ?? now).onboarding,
    }).then((result) => {
      useButlerStore.getState().setModelCatalog(result.catalog);
      useButlerStore.getState().setSettings(result.settings);
      if (mounted.current) setConnected({ cardId: pending.cardId, settings: result.settings });
    }).catch(() => {
      if (mounted.current) setFailed(true);
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setCommitting(false);
    });
  }, [acceptedAt, connected, failed, language, pending, readinessStatus]);

  useEffect(() => {
    if (!resume || readinessStatus !== "ready") return;
    let cancelled = false;
    void Promise.all([api<SettingsView>("/settings"), api<ModelCatalogView>("/model-catalog")]).then(([settings, catalog]) => {
      if (cancelled || !settings.onboarding?.accepted_at || settings.onboarding.completed_at) return;
      const model = catalog.registered_models?.find((entry) => entry.model_ref === settings.model);
      const cardId = connectionCardId(model);
      if (cardId) {
        useButlerStore.getState().setModelCatalog(catalog);
        setConnected({ cardId, settings });
      }
    }).catch(() => { /* The normal connection path remains available. */ });
    return () => { cancelled = true; };
  }, [readinessStatus, resume]);

  return {
    connected,
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
      setConnected(null);
    },
  };
}
