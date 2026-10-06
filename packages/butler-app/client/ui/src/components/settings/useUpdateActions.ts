import { useCallback, type Dispatch, type SetStateAction } from "react";
import { appCopy } from "@/app/copy";
import { api } from "@/app/api";
import type { UpdateApplyResult, UpdateComponentId, UpdateStatusView } from "@/app/types";
import { useUpdateProgressStore } from "@/stores/updateProgressStore";
import { emptyComponentStatus, UPDATE_COMPONENTS } from "./UpdateComponentRow";

type Setter<T> = Dispatch<SetStateAction<T>>;
export function useUpdateActions({ setView, setLoading, setLoadFailed, reportError }: {
  setView: Setter<UpdateStatusView | null>; setLoading: Setter<boolean>; setLoadFailed: Setter<boolean>;
  reportError: (error: unknown, action: "check" | "apply") => void;
}) {
  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const snapshot = await api<UpdateStatusView>("/updates");
      useUpdateProgressStore.getState().receive(snapshot.progress);
      setView(snapshot);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setLoadFailed, setView]);

  const check = useCallback(async (silent = false) => {
    setLoading(true);
    try {
      const snapshot = await api<UpdateStatusView>("/updates/check", {
        method: "POST",
        body: JSON.stringify({ component: "app" }),
      });
      useUpdateProgressStore.getState().receive(snapshot.progress);
      setView(snapshot);
    } catch (error) {
      if (!silent) reportError(error, "check");
    } finally {
      setLoading(false);
    }
  }, [reportError, setLoading, setView]);

  const apply = useCallback(async (component: UpdateComponentId) => {
    try {
      const result = await api<UpdateApplyResult>("/updates/apply", {
        method: "POST",
        body: JSON.stringify({ component }),
      });
      setView((previous) => mergeUpdateResult(previous, result));
    } catch (error) {
      // The failed/cancelled snapshot owns feedback, including a response arriving after SSE.
      try {
        const snapshot = await api<UpdateStatusView>("/updates");
        useUpdateProgressStore.getState().receive(snapshot.progress);
        setView(snapshot);
        if (snapshot.progress?.stage === "failed") return;
      } catch { /* Keep the stream's latest state when the source is unavailable. */ }
      reportError(new Error(appCopy.settings.updateErrors.generic), "apply");
    }
  }, [reportError, setView]);

  return { load, check, apply };
}

function mergeUpdateResult(
  view: UpdateStatusView | null,
  result: UpdateApplyResult,
): UpdateStatusView {
  const generatedAt = result.checked_at;
  const components = view?.components ?? UPDATE_COMPONENTS.map(emptyComponentStatus);
  return {
    generated_at: generatedAt,
    components: components.map((component) =>
      component.component === result.component ? result : component,
    ),
    storage_label: "updates",
    manifest_source: result.manifest_source,
    raw_text_included: false,
  };
}
