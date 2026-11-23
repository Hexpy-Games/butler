import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { ImageViewer } from "@/ds/ImageViewer";
import { useAppLocale } from "@/i18n";
import { closeImageViewer, openImageViewer, useImageViewer } from "./imageViewer";

export function ImageViewerHost() {
  const { images, index } = useImageViewer();
  const copy = getAppCopy(useAppLocale());
  return <ImageViewer images={images} index={index} onIndexChange={next => openImageViewer(images, next)}
    onClose={closeImageViewer} labels={{ ...copy.conversation.imageViewer, share: copy.mobile.outputs.share, saveToLibrary: copy.conversation.answerBlocks.saveToLibrary }} />;
}
