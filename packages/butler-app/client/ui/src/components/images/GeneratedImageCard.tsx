import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy";
import { ButtonContainer, Clickable, MediaFrame, Stack } from "@/butler-ds";
import { openImageViewer } from "../media/imageViewerState";
import { assetSource, getImageMeta, imageAspect, type ImageAsset } from "./imageApi";
import { GeneratedImageActions } from "./GeneratedImageActions";

/** Gateway-signed image URLs carry `expires` (unix seconds); an unsigned URL never expires. */
function signatureExpiresSoon(url: string): boolean {
  const expires = Number(new URL(url, "http://gateway.invalid").searchParams.get("expires"));
  return expires > 0 && expires * 1000 - Date.now() <= 60_000;
}

export function GeneratedImageCard({ asset, images, index, session, title }: { asset: ImageAsset; images: ImageAsset[]; index: number; session: string; title: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [fresh, setFresh] = useState<ImageAsset>();
  const current = fresh?.id === asset.id ? fresh : asset;
  const [shownWidth, setShownWidth] = useState(width);
  const pending = useRef<Promise<ImageAsset | undefined>>(undefined);
  /** One shared re-sign at a time; failure leaves the card as it was. */
  const resign = () => pending.current ??= getImageMeta(current.id).then(next => { setFresh(next); return next; }, () => undefined)
    .finally(() => { pending.current = undefined; });
  useEffect(() => {
    if (!signatureExpiresSoon(current.image_url)) { setShownWidth(width); return; }
    void resign().then(next => { if (next) setShownWidth(width); });
  }, [width]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setWidth(Math.min(1280, Math.ceil(width * devicePixelRatio))); });
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const alt = title;
  return <div ref={frame} data-test-class="generated-image-card"><Stack gap="sm">
    <Clickable stretch aria-label={appCopy.conversation.imageViewer.viewImage(alt)} onClick={async () => {
      const shown = await Promise.all(images.map(item => item.id === current.id
        ? (signatureExpiresSoon(current.image_url) ? resign().then(next => next ?? current) : current)
        : (signatureExpiresSoon(item.image_url) ? getImageMeta(item.id).catch(() => item) : item)));
      openImageViewer(shown.map(item => ({ src: assetSource(item), alt, asset: item, sessionId: session })), index);
    }}>
      <Stack grow minWidth="0"><MediaFrame src={assetSource(current, shownWidth)} alt={alt} aspect={imageAspect(asset.width, asset.height)} fit="contain" placeholder /></Stack>
    </Clickable>
    <ButtonContainer size="sm"><GeneratedImageActions asset={current} session={session} title={title} /></ButtonContainer>
  </Stack></div>;
}
