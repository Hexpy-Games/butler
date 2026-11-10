import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { ProgressRow } from "@/app/types";
import { Clickable, MediaFrame, Stack } from "@/butler-ds";
import { openImageViewer, type ViewerImage } from "../media/imageViewerState";
import { assetSource, imageAspect } from "./imageApi";
import { useImageOutputs } from "./useImageOutputs";

/** An image tool record's result, as the browser tool's still: a small tile that opens the viewer. */
export function ImageToolStill({ turnId, row }: { turnId: string; row: ProgressRow }) {
  const { images } = useImageOutputs(turnId, [row]);
  const sessionId = useButlerStore((state) => state.activeChatId);
  if (images.length === 0) return null;
  const alt = appCopy.conversation.answerBlocks.image;
  const shots: ViewerImage[] = images.map((asset) => ({ src: assetSource(asset), alt, asset, sessionId }));
  return <Stack align="row" cross="start" data-test-class="image-tool-still"><Stack basis="xs" shrink minWidth="0">
    {images.map((asset, index) => (
      <Clickable key={asset.id} variant="text" stretch aria-label={appCopy.conversation.imageViewer.viewImage(alt)} onClick={() => openImageViewer(shots, index)}>
        <Stack grow minWidth="0"><MediaFrame src={assetSource(asset, 320)} alt={alt} aspect={imageAspect(asset.width, asset.height)} placeholder /></Stack>
      </Clickable>
    ))}
  </Stack></Stack>;
}
