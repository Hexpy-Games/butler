import { useState } from "react";
import { createCanonTag, type CanonTag, type CanonTagExists } from "@/app/canonApi.ts";
import { apiErrorCode } from "@/app/api.ts";
import { useCanonTags } from "./useCanonTags.ts";
import { CanonTagManageDialog, type TagAction } from "./CanonTagManageDialog.tsx";
import { canonWriteFailure } from "./canonFeedback.ts";
/** Tag create and rename/recolor/delete for every tag picker; each picker decides what a created or deleted tag does to its own selection. */
export function useCanonTagEditor(projectId: string, { onCreated, onDeleted }: {
  onCreated?: (tag: CanonTag) => void; onDeleted?: (tag: CanonTag) => void;
} = {}) {
  const { tags, refresh } = useCanonTags(projectId);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState<{ tag: CanonTag; action: TagAction } | null>(null);
  const create = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      // New tags start blue. Choosing another swatch is a revision-checked tag edit.
      // An existing tag with the same name is handed back as it is.
      let tag: CanonTag, created = true;
      try { tag = await createCanonTag(projectId, { name, color: "blue" }); }
      catch (error) {
        if (apiErrorCode(error) !== "tag_exists") throw error;
        tag = (error as CanonTagExists).existing; created = false;
      }
      onCreated?.(tag);
      await refresh();
      if (created) setManage({ tag, action: "color" });
    } catch (error) { await canonWriteFailure(error, refresh); }
    finally { setBusy(false); }
  };
  const dialog = manage && <CanonTagManageDialog key={`${manage.tag.id}-${manage.action}`} {...manage} onClose={() => setManage(null)} onRefresh={refresh}
    onDeleted={() => onDeleted?.(manage.tag)} />;
  return { tags, busy, dialog, onCreate: (name: string) => void create(name), onManage: (tag: CanonTag, action: TagAction) => setManage({ tag, action }) };
}
