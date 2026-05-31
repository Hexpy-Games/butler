import { useEffect, useMemo } from "react";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { AppModelSummary, LocalModelDiscoveryRequest } from "@/app/types.ts";

interface LocalModelUnsavedGuardProps {
  initialEditModel: AppModelSummary | null;
  isEditing: boolean;
  platform: LocalModelDiscoveryRequest["platform"];
  serverUrl: string;
  modelId: string;
  displayName: string;
  context: string;
}

export function useLocalModelUnsavedGuard({
  initialEditModel,
  isEditing,
  platform,
  serverUrl,
  modelId,
  displayName,
  context,
}: LocalModelUnsavedGuardProps) {
  const setLeaveGuard = useSettingsUIStore((state) => state.setModelRouteLeaveGuard);
  const warning = appCopy.settings.localModels.unsavedChanges;
  const baseline = useMemo(() => localModelBaseline(initialEditModel), [
    initialEditModel,
  ]);
  const hasUnsavedChanges = Boolean(
    isEditing &&
      baseline &&
      (platform !== baseline.platform ||
        serverUrl !== baseline.serverUrl ||
        modelId !== baseline.modelId ||
        displayName !== baseline.displayName ||
        context !== baseline.context),
  );

  useEffect(() => {
    if (!isEditing) {
      setLeaveGuard(null);
      return;
    }
    setLeaveGuard(() => !hasUnsavedChanges || window.confirm(warning));
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
    serverUrl: model.server_url ?? "",
    modelId: model.model_id,
    displayName: model.display_name,
    context: String(model.context_window_tokens),
  };
}
