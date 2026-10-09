import { useEffect } from "react";
import { AttachmentList } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { messageFileUrl } from "../conversation/messageMedia";
import { useComposerStore } from "../conversation/composerStore";
import { removeElement, restoreElementDraft, useElementDraft } from "./browserElements";
export function ComposerElements() {
  useAppLocale();
  const session = useComposerStore(s => s.draftSessionId);
  const draft = useElementDraft();
  useEffect(() => { void restoreElementDraft(session); }, [session]);
  if (draft.session !== session || !draft.items.length) return null;
  return <AttachmentList variant="chips" windowDrag="no-drag" removeLabel={appCopy.browser.remove}
    items={draft.items.map(item => ({ id: item.id, name: item.title, element: { site: item.site }, thumbnail: { src: messageFileUrl(item.crop) } }))}
    onRemove={id => void removeElement(session, id)} />;
}
