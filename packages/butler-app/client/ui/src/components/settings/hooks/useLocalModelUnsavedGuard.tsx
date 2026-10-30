import { useEffect, useMemo } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { AppModelSummary, LocalModelDiscoveryRequest } from "@/app/types.ts";
import { responseTimeoutSeconds } from "../localModelApi";

interface LocalModelUnsavedGuardProps {
  initialEditModel: AppModelSummary | null;
  isEditing: boolean;
  platform: LocalModelDiscoveryRequest["platform"];
  serverUrl: string;
  apiKey?: string;
  modelId: string;
  displayName: string;
  context: string;
  responseTimeout: string;
  imageInputChanged: boolean;
}

export function useLocalModelUnsavedGuard({
  initialEditModel,
  isEditing,
  platform,
  serverUrl,
  apiKey,
  modelId,
  displayName,
  context,
  responseTimeout,
  imageInputChanged,
}: LocalModelUnsavedGuardProps) {
  const setLeaveGuard = useSettingsUIStore((state) => state.setModelRouteLeaveGuard);
  const warning = appCopy.settings.localModels.unsavedChanges;
  const baseline = useMemo(() => localModelBaseline(initialEditModel), [
    initialEditModel,
  ]);
  const hasUnsavedChanges = Boolean(
    isEditing &&
      baseline &&
      (apiKey !== undefined ||
        imageInputChanged ||
        platform !== baseline.platform ||
        serverUrl !== baseline.serverUrl ||
        modelId !== baseline.modelId ||
        displayName !== baseline.displayName ||
        context !== baseline.context ||
        responseTimeout !== baseline.responseTimeout),
  );

  useEffect(() => {
    if (!isEditing) {
      setLeaveGuard(null);
      return;
    }
    setLeaveGuard(() => !hasUnsavedChanges || confirmAction(warning));
    return () => setLeaveGuard(null);
  }, [hasUnsavedChanges, isEditing, setLeaveGuard, warning]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = warning;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges, warning]);

  return {
    hasUnsavedChanges,
    clearLeaveGuard: () => setLeaveGuard(null),
  };
}

function localModelBaseline(model: AppModelSummary | null) {
  if (!model) return null;
  return {
    platform: model.platform ?? "llama_cpp",
    serverUrl: model.api_base_url ?? model.server_url ?? "",
    modelId: model.model_id,
    displayName: model.display_name,
    context: String(model.context_window_tokens),
    responseTimeout: responseTimeoutSeconds(model.response_timeout_ms),
  };
}
