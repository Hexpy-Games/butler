import { useLayoutEffect, useRef, useState } from "react";
import type { EpicDetail, EpicInput } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";

import { useCanonInlineDraft, type EpicTextField } from "./CanonInlineDraft.tsx";
export type { EpicTextField } from "./CanonInlineDraft.tsx";

export function useEpicInlineEdit(epic: EpicDetail, onWrite: (input: EpicInput, message?: string) => Promise<boolean>) {
  const [draft, setDraft] = useCanonInlineDraft();
  const [failedRevision, setFailedRevision] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (failedRevision === null || epic.revision <= failedRevision) return;
    setDraft(current => current?.base.id === epic.id && current.revision === failedRevision
      ? { ...current, current: epic, revision: epic.revision } : current);
    setFailedRevision(null);
  }, [epic, failedRevision, setDraft]);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const cancel = () => { setFailedRevision(null); setDraft(null); };
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
      else setFailedRevision(draft.revision);
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
