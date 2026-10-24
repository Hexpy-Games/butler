import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import { Box, Stack, Button, ButtonContainer, IconButton, MaskCanvas, Spinner, Textarea, Tooltip, Typo, XIcon, type MaskCanvasHandle, type MaskTool } from "@/butler-ds";
import { useComposerStore } from "../conversation/composerStore";
import { assetSource, getImageVersions, uploadImageMask, type ImageAsset } from "./imageApi";
import { closeImageEditor, selectImageEditorVersion, useImageEditorState } from "./imageEditorState";
import { ImageEditorToolbar } from "./ImageEditorToolbar";
import { ImageVersionStrip } from "./ImageVersionStrip";
import { useImageEditTurn } from "./useImageEditTurn";
import { useImageModelReady } from "./imageSettingsState";

export function ImageEditor({ session, initial }: { session: string; initial: ImageAsset }) {
  useAppLocale();
  const c = appCopy.conversation.imageTools;
  const canvas = useRef<MaskCanvasHandle>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [asset, setAsset] = useState(() => useImageEditorState.getState().target?.selected ?? initial), [versions, setVersions] = useState<ImageAsset[]>([initial]);
  const [tool, setTool] = useState<MaskTool>("brush"), [size, setSize] = useState(32);
  const [strokes, setStrokes] = useState(0), [compare, setCompare] = useState(false), [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const readOnly = useComposerStore(s => s.accessMode) === "read_only";
  const ready = useImageModelReady();
  const turn = useImageEditTurn(asset.id);
  const locked = sending || turn.generating || Boolean(turn.result);
  const reason = readOnly ? c.readOnly : !ready ? c.noModel : undefined;
  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void getImageVersions(asset.id, controller.signal).then(setVersions, () => {});
    return () => controller.abort();
  }, [asset.id]);
  const send = async () => {
    if (reason || locked || !text.trim() || useButlerStore.getState().activeChatId !== session) return;
    setSending(true);
    let accepted = false;
    try {
      const mask = await canvas.current?.toMask();
      const maskId = mask ? await uploadImageMask(session, asset.id, mask) : undefined;
      await useButlerStore.getState().sendMessage(text, { imageEdit: { image: asset.id, ...(maskId ? { mask: maskId } : {}) },
        accessMode: useComposerStore.getState().accessMode, queuePolicy: "send_now",
        onImageEditAccepted: id => { accepted = true; turn.accepted(id); setText(""); } });
      if (!accepted) notifyStatus(c.failed, { tone: "error" });
    } catch { notifyStatus(c.failed, { tone: "error" }); }
    finally { setSending(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = event.target instanceof HTMLElement && (event.target.matches("input,textarea") || event.target.isContentEditable);
    if (typing) return;
    if (event.key === "Escape") { event.preventDefault(); closeImageEditor(); return; }
    if (locked) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); canvas.current?.undo(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === "b") setTool("brush");
    if (event.key.toLowerCase() === "e") setTool("eraser");
    if (event.key === "[" || event.key === "]") setSize(n => Math.max(4, Math.min(160, n + (event.key === "[" ? -4 : 4))));
  };
  const selectVersion = (next: ImageAsset) => {
    setCompare(false); setAsset(next); selectImageEditorVersion(next);
  };
  const shown = () => {
    if (!turn.result) return;
    selectVersion(turn.result); canvas.current?.clear(); turn.shown();
  };
  return <Stack fill role="region" aria-label={c.editor} tabIndex={-1} onKeyDown={onKeyDown} data-test-class="image-editor">
    <Box padding="md"><Stack align="row" justify="between" cross="center" shrink={false}><Typo.Label>{c.editor}</Typo.Label>
      <IconButton ref={closeButton} label={appCopy.common.close} onClick={closeImageEditor}><XIcon size="sm" /></IconButton></Stack></Box>
    <Box paddingX="md"><ImageEditorToolbar tool={tool} size={size} strokes={strokes} compare={compare} locked={locked} onTool={setTool} onSize={setSize}
      onUndo={() => canvas.current?.undo()} onCompare={setCompare} /></Box>
    <Box grow basis="0" paddingX="md"><MaskCanvas ref={canvas} src={assetSource(asset)} alt={c.editor} width={asset.width} height={asset.height}
      tool={tool} brushSize={size} onChange={state => setStrokes(state.strokes)} disabled={locked}
      compareSrc={compare ? assetSource(versions.find(v => !v.parent_id) ?? initial) : undefined}
      generating={sending || turn.generating} resultSrc={turn.result ? assetSource(turn.result) : undefined} onResultShown={shown} /></Box>
    <ImageVersionStrip versions={versions} current={asset.id} disabled={locked} onSelect={selectVersion} />
    <Box paddingX="md"><Textarea aria-label={c.instruction} placeholder={c.instruction} value={text} onChange={event => setText(event.target.value)} /></Box>
    <Box padding="md"><ButtonContainer size="sm" justify="end"><Tooltip label={reason}><Button disabled={Boolean(reason) || locked || !text.trim()}
      onClick={() => void send()} iconStart={locked ? <Spinner /> : undefined}>{c.send}</Button></Tooltip></ButtonContainer></Box>
  </Stack>;
}
