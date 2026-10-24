import { useRef } from "react";
import { getCanonEpic, type EpicDetail, type EpicInput } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";

import { useCanonInlineDraft, type EpicTextField } from "./CanonInlineDraft.tsx";
export type { EpicTextField } from "./CanonInlineDraft.tsx";

export function useEpicInlineEdit(epic: EpicDetail, onWrite: (input: EpicInput, message?: string) => Promise<boolean>) {
  const [draft, setDraft] = useCanonInlineDraft();
  const inFlight = useRef<Promise<boolean> | null>(null);
  const cancel = () => setDraft(null);
  const dirty = Boolean(draft && draft.value !== draft.base[draft.field]);
  const valid = !draft || draft.field !== "title" || Boolean(draft.value.trim());
  const save = (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    if (!draft || !valid) return Promise.resolve(false);
    if (!dirty) { cancel(); return Promise.resolve(true); }
    const run = async () => {
      const saved = await onWrite({ [draft.field]: draft.field === "title" ? draft.value.trim() : draft.value,
        expected_revision: draft.revision }, appCopy.canon.inlineEdit.saved);
      if (saved) cancel();
      else {
        // Refreshing the board never replaces the person's draft. A second save
        // uses the current revision only after the failed write has completed.
        try {
          const current = await getCanonEpic(epic.id);
          if (current.revision !== draft.revision) setDraft({ ...draft, current, revision: current.revision });
        } catch { /* The existing write path already reported the error. */ }
      }
      return saved;
    };
    inFlight.current = run().finally(() => { inFlight.current = null; });
    return inFlight.current;
  };
  return { draft, dirty, valid, save, cancel,
    begin: (field: EpicTextField) => setDraft({ field, value: epic[field], base: epic, revision: epic.revision }),
    change: (value: string) => setDraft(current => current && current.base.id === epic.id && current.field === draft?.field ? { ...current, value } : current),
  };
}
