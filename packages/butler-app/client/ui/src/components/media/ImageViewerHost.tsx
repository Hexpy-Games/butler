import { GeneratedImageActions } from "../images/GeneratedImageActions";
import { useMemo } from "react";
import { Copy, DoneIconButton, IconButton, ImageViewer, Library, Popup, type ImageViewerImage } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { faviconSrc } from "@/app/favicons";
import { answerActionFailed, runAnswerAction } from "../conversation/answerBlockActions";
import { checkedLabel, copyViewerImage, openViewerSource, saveViewerImage, siteOf } from "./imageActions";
import { closeImageViewer, useImageViewerState, type ViewerImage } from "./imageViewerState";

function viewerImage(image: ViewerImage, checked: (time: string) => string): ImageViewerImage {
  const site = siteOf(image.source);
  const time = checkedLabel(image.checked);
  return { src: image.src, alt: image.alt, kind: image.kind, caption: image.asset ? undefined : image.caption ?? (image.alt || undefined),
    source: site ? { site, checked: time ? checked(time) : undefined, icon: image.source ? faviconSrc(image.source) : undefined } : undefined };
}

/** The window's one image viewer; pictures anywhere open it through `openImageViewer`. */
export function ImageViewerHost() {
  useAppLocale();
  const { images, index } = useImageViewerState();
  const copy = appCopy.conversation.imageViewer;
  const blocks = appCopy.conversation.answerBlocks;
  const shown = useMemo(() => images.map((image) => viewerImage(image, copy.checked)), [images, copy.checked]);
  const current = index === null ? undefined : images[index];
  const actions = current?.asset && current.sessionId ? <GeneratedImageActions asset={current.asset} session={current.sessionId} title={current.alt} /> : current ? <>
    {current.source || current.openSource ? <IconButton label={copy.openSource} onClick={() => {
      closeImageViewer();
      runAnswerAction(async () => { await openViewerSource(current); });
    }}><Popup size="sm" /></IconButton> : null}
    {/* A 서랍 scrap belongs to a page; a picture without one is copied, not saved. */}
    {current.source ? <DoneIconButton key={index} icon={<Library size="sm" />} label={blocks.saveToLibrary} doneLabel={blocks.savedToLibrary}
      announce={false} onAction={() => saveViewerImage(current)} onError={answerActionFailed} /> : null}
    {current.kind === "video" ? null : <DoneIconButton key={`copy-${index}`} icon={<Copy size="sm" />} label={copy.copyImage} doneLabel={copy.imageCopied}
      announce={false} onAction={() => copyViewerImage(current)} onError={answerActionFailed} />}
  </> : undefined;
  return <ImageViewer images={shown} index={index} onIndexChange={(next) => useImageViewerState.setState({ index: next })}
    onClose={closeImageViewer} actions={actions}
    labels={{ zoomIn: copy.zoomIn, zoomOut: copy.zoomOut, close: copy.close, previous: copy.previous, next: copy.next, position: copy.position, failed: copy.failed }} />;
}
