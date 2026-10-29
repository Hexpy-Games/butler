import { maskedPreview } from "../media/imageEncode";
import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import type { AuthorityApprovalCard } from "@/app/types";
import { MediaFrame, Stack, type ComposerDecisionMedia } from "@/butler-ds";
import { assetSource, imageAspect } from "./imageApi";
import { useImageAsset } from "./useImageAsset";

function ApprovalThumbnail({ image, mask }: { image: string; mask?: string | null }) {
  const { asset } = useImageAsset(image), { asset: maskAsset } = useImageAsset(mask ?? undefined);
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); let url: string | undefined;
    setPreview(undefined);
    if (asset && maskAsset) void maskedPreview(assetSource(asset, 256), assetSource(maskAsset, 256), controller.signal).then(blob => {
      if (!controller.signal.aborted) { url = URL.createObjectURL(blob); setPreview(url); }
    }, () => {});
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [asset, maskAsset]);
  return <Stack grow minWidth="0"><MediaFrame src={preview ?? (asset ? assetSource(asset, 256) : undefined)}
    alt={appCopy.conversation.imageTools.original} aspect={asset ? imageAspect(asset.width, asset.height) : "1:1"} fit="contain" /></Stack>;
}
export function imageApprovalMedia(request?: AuthorityApprovalCard): ComposerDecisionMedia | undefined {
  const image = request?.approval?.operation?.image;
  if (!image?.images.length) return;
  return { label: appCopy.conversation.imageTools.editor, content: <Stack align="row" fill gap="xs">
    {image.images.map((id, index) => <ApprovalThumbnail key={`${id}-${index}`} image={id} mask={index === 0 ? image.mask : undefined} />)}
  </Stack> };
}
