import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy";
import { ButtonContainer, Clickable, MediaFrame, Stack } from "@/butler-ds";
import { openImageViewer } from "../media/imageViewerState";
import { assetSource, imageAspect, type ImageAsset } from "./imageApi";
import { GeneratedImageActions } from "./GeneratedImageActions";

export function GeneratedImageCard({ asset, images, index, session, title }: { asset: ImageAsset; images: ImageAsset[]; index: number; session: string; title: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setWidth(Math.min(1280, Math.ceil(width * devicePixelRatio))); });
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const alt = title;
  return <div ref={frame} data-test-class="generated-image-card"><Stack gap="sm">
    <Clickable stretch aria-label={appCopy.conversation.imageViewer.viewImage(alt)} onClick={() => openImageViewer(images.map(asset => ({
      src: assetSource(asset), alt, asset, sessionId: session,
    })), index)}>
      <Stack grow minWidth="0"><MediaFrame src={assetSource(asset, width)} alt={alt} aspect={imageAspect(asset.width, asset.height)} fit="contain" placeholder /></Stack>
    </Clickable>
    <ButtonContainer size="sm"><GeneratedImageActions asset={asset} session={session} title={title} /></ButtonContainer>
  </Stack></div>;
}
