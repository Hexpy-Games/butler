import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { modelDisplayName } from "@/app/utils.ts";
import {
  localModelPayload,
  discoverLocalModels,
  registerLocalModel,
  deleteLocalModel,
} from "../localModelApi";
import type {
  AppModelSummary,
  LocalModelDiscoveryRequest,
  LocalModelDiscoveryResult,
  ModelCatalogView,
} from "@/app/types.ts";

interface UseLocalModelOperationsProps {
  platform: LocalModelDiscoveryRequest["platform"];
  serverUrl: string;
  manualModelId: string;
  manualDisplayName: string;
  manualContext: string;
  preservedReasoningBudgetRatio?: number;
  editingModelRef: string;
  selectedModel: AppModelSummary | null;
  canDiscover: boolean;
  canRegister: boolean;
  isEditing: boolean;
  busy: "discover" | "register" | "delete" | null;
  setDiscovery: (value: LocalModelDiscoveryResult | null) => void;
  setSelectedModelRef: (value: string) => void;
  setManualModelId: (value: string) => void;
  setManualDisplayName: (value: string) => void;
  setManualContext: (value: string) => void;
  setBusy: (value: "discover" | "register" | "delete" | null) => void;
  setStatus: (value: string) => void;
  onCatalogChange: (catalog: ModelCatalogView) => void;
  onSaved?: () => void;
}

export function useLocalModelOperations({
  platform,
  serverUrl,
  manualModelId,
  manualDisplayName,
  manualContext,
  preservedReasoningBudgetRatio,
  editingModelRef,
  selectedModel,
  canDiscover,
  canRegister,
  isEditing,
  busy,
  setDiscovery,
  setSelectedModelRef,
  setManualModelId,
  setManualDisplayName,
  setManualContext,
  setBusy,
  setStatus,
  onCatalogChange,
  onSaved,
}: UseLocalModelOperationsProps) {
  const copy = appCopy.settings.localModels;

  async function discover() {
    if (!canDiscover) return;
    setBusy("discover");
    setStatus("");
    setDiscovery(null);
    try {
      const result = await discoverLocalModels(platform, serverUrl);
      setDiscovery(result);
      setSelectedModelRef(result.models[0]?.model_ref ?? "");
      setManualModelId(result.models[0]?.model_id ?? manualModelId);
      setManualDisplayName(result.models[0]?.display_name ?? manualDisplayName);
      setManualContext(
        String(result.models[0]?.context_window_tokens ?? manualContext),
      );
      setStatus(copy.discoveredStatus(result.models.length));
    } catch (error) {
      notifyError(error, copy.errors.discover, { id: "local-model-discovery" });
    } finally {
      setBusy(null);
    }
  }

  async function register() {
    if (!canRegister) return;
    setBusy("register");
    setStatus("");
    const sourceModel = selectedModel;
    const payload = localModelPayload(
      sourceModel,
      platform,
      serverUrl,
      manualModelId,
      manualDisplayName,
      manualContext,
      preservedReasoningBudgetRatio,
    );
    try {
      const result = await registerLocalModel(isEditing, editingModelRef, payload);
      onCatalogChange(result.catalog);
      notifyStatus(
        isEditing
          ? copy.savedStatus(modelDisplayName(result.model))
          : copy.registeredStatus(modelDisplayName(result.model)),
        {
          id: isEditing ? "local-model-update" : "local-model-registration",
          tone: "ok",
        },
      );
      onSaved?.();
    } catch (error) {
      notifyError(
        error,
        isEditing ? copy.errors.update : copy.errors.register,
        {
          id: isEditing ? "local-model-update" : "local-model-registration",
        },
      );
    } finally {
      setBusy(null);
    }
  }

  async function deleteModel(model: AppModelSummary) {
    if (busy) return;
    setBusy("delete");
    setStatus("");
    try {
      const result = await deleteLocalModel(model);
      onCatalogChange(result.catalog);
      notifyStatus(copy.deletedStatus(modelDisplayName(model)), {
        id: "local-model-delete",
        tone: "ok",
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Deletion cancelled") {
        notifyError(error, copy.errors.delete, { id: "local-model-delete" });
      }
    } finally {
      setBusy(null);
    }
  }

  return {
    discover,
    register,
    deleteModel,
  };
}
