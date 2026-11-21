import { useEffect, useState } from "react";
import type { ModelCatalog, ReasoningEffort, SessionControlsView } from "../../../butler-protocol/src/index.ts";
import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import { showToast } from "@/ds";
import { useMobileCopy } from "@/i18n";
import { useSettings } from "@/settings/useSettings";
import { draftControls, type DraftControls } from "./draftControls";
import { useConversation } from "./live";

const catalogs = new WeakMap<GatewayClient, Promise<ModelCatalog>>();

export function useControls(sessionId: string | undefined) {
  const { client } = useConversation();
  const copy = useMobileCopy();
  const { settings } = useSettings();
  const [draft, setDraft] = useState<DraftControls | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [view, setView] = useState<SessionControlsView | null>(null);
  useEffect(() => {
    setView(null); setCatalog(null); setDraft(null);
    if (!client) return;
    let closed = false;
    let request = catalogs.get(client);
    if (!request) {
      request = client.request<ModelCatalog>("/model-catalog");
      catalogs.set(client, request);
    }
    void Promise.all([request, sessionId ? client.request<SessionControlsView>(`/sessions/${encodeURIComponent(sessionId)}/controls`) : null])
      .then(([nextCatalog, nextView]) => {
        if (!closed) { setCatalog(nextCatalog); setView(nextView); }
      }).catch(() => {
        catalogs.delete(client);
        if (!closed) showToast({ message: copy.chat.modelFailed, tone: "error" });
      });
    return () => { closed = true; };
  }, [client, sessionId, copy]);
  useEffect(() => {
    if (!client || !view || !catalog || view.catalog_generation === catalog.generation) return;
    let closed = false;
    const request = client.request<ModelCatalog>("/model-catalog");
    catalogs.set(client, request);
    void request.then(next => { if (!closed) setCatalog(next); })
      .catch(() => { if (!closed) showToast({ message: copy.chat.modelFailed, tone: "error" }); });
    return () => { closed = true; };
  }, [client, view?.catalog_generation, catalog?.generation, copy]);
  const controls = sessionId ? view?.controls : draft ?? (catalog && settings ? draftControls(catalog, settings) ?? undefined : undefined);
  const models = catalog?.registered_models?.length ? catalog.registered_models : catalog?.models ?? [];
  const current = models.find(model => model.model_ref === controls?.model);
  const apply = async (patch: { model?: string; reasoning_effort?: ReasoningEffort }) => {
    if (!client || !controls) return;
    const model = models.find(item => item.model_ref === patch.model);
    if (model && model.model_ref !== controls.model && !model.reasoning_efforts.includes(controls.reasoning_effort)) {
      patch = { ...patch, reasoning_effort: model.default_reasoning_effort };
    }
    if (!sessionId) { setDraft({ model: patch.model ?? controls.model, reasoning_effort: patch.reasoning_effort ?? controls.reasoning_effort }); return; }
    try {
      const next = await client.request<SessionControlsView>(`/sessions/${encodeURIComponent(sessionId)}/controls`, { method: "PATCH", body: patch });
      setView(previous => previous && next.revision < previous.revision ? previous : next);
    } catch { showToast({ message: copy.chat.modelFailed, tone: "error" }); }
  };
  return { controls, models, current, apply };
}
