import { appCopy, useAppLocale } from "@/app/copy";
import { DoneIconButton, Download, IconButton, Library, Pencil } from "@/butler-ds";
import { answerActionFailed, runAnswerAction } from "../conversation/answerBlockActions";
import { useComposerStore } from "../conversation/composerStore";
import { saveLibrary } from "../browser/libraryStore";
import { assetSource, type ImageAsset } from "./imageApi";
import { openImageEditor } from "./imageEditorState";
import { useImageModelReady } from "./imageSettingsState";

export async function saveGeneratedImage(asset: ImageAsset, session: string, title: string) {
  await saveLibrary({ id: crypto.randomUUID(), kind: "scrap", title,
    url: "", asset: asset.id, text: "", session, capturedAt: new Date().toISOString() });
}
export async function downloadGeneratedImage(asset: ImageAsset) {
  const name = `${asset.id}.${asset.mime === "image/webp" ? "webp" : asset.mime === "image/jpeg" ? "jpg" : "png"}`;
  if (window.butlerApp) {
    const save = window.butlerApp.saveImageAsset as ((input: { id: string; suggestedName: string }) => Promise<unknown>) | undefined;
    if (!save) throw new Error("image_save_bridge_unavailable");
    await save({ id: asset.id, suggestedName: name });
  } else {
    const link = document.createElement("a"); link.href = assetSource(asset, undefined, true); link.download = name;
    document.body.append(link); link.click(); link.remove();
  }
}
export function GeneratedImageActions({ asset, session, title }: { asset: ImageAsset; session: string; title: string }) {
  useAppLocale();
  const ready = useImageModelReady();
  const readOnly = useComposerStore(s => s.accessMode) === "read_only";
  const copy = appCopy.conversation.imageTools;
  const blocks = appCopy.conversation.answerBlocks;
  const reason = readOnly ? copy.readOnly : !ready ? copy.noModel : undefined;
  return <>
    <IconButton label={reason ?? copy.edit} aria-label={copy.edit} disabled={Boolean(reason)} onClick={() => openImageEditor(session, asset)}><Pencil size="sm" /></IconButton>
    <DoneIconButton key={asset.id} icon={<Library size="sm" />} label={blocks.saveToLibrary} doneLabel={blocks.savedToLibrary}
      announce={false} onAction={() => saveGeneratedImage(asset, session, title)} onError={answerActionFailed} />
    <IconButton label={copy.download} onClick={() => runAnswerAction(() => downloadGeneratedImage(asset))}><Download size="sm" /></IconButton>
  </>;
}
