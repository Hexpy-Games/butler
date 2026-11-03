import { useEffect } from "react";
import { AttachmentList } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { messageFileUrl } from "../conversation/messageMedia";
import { useComposerStore } from "../conversation/composerStore";
import { imageRefusalLabel } from "../conversation/composerImagePolicy";
import { removeElement, restoreElementDraft, useElementDraft } from "./browserElements";
export function ComposerElements() {
  useAppLocale();
  const session = useComposerStore(s => s.draftSessionId);
  const draft = useElementDraft();
  const blocked = useComposerStore(s => s.blockedAttachments);
  useEffect(() => { void restoreElementDraft(session); }, [session]);
  if (draft.session !== session || !draft.items.length) return null;
  const items = draft.items.map(item => {
    const refusal = blocked.get(item.id);
    const image = item.file.kind === "image" ? item.file : item.crop;
    return {
      id: item.id,
      name: item.title,
      element: item.kind === "library" || refusal ? undefined : { site: item.site },
      meta: item.site,
      blockedReason: refusal ? imageRefusalLabel(refusal) : undefined,
      thumbnail: image ? { src: messageFileUrl(image), fit: "contain" as const } : undefined,
    };
  });
  return <AttachmentList variant="chips" windowDrag="no-drag" removeLabel={appCopy.browser.remove}
    items={items} onRemove={id => void removeElement(session, id)} />;
}
