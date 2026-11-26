import { useContext } from "react";
import { View } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { Access } from "@/connection/access";
import { useTokens } from "@/design/useTokens";
import { ImageFrame } from "@/ds/ImageFrame";
import { TILE_RADIUS } from "@/ds/AttachmentTiles";
import type { WorkActivityToolItem } from "@/ds/WorkActivityTools";
import { AnimatedPressable, usePress } from "@/ds/internal/press";
import { useAppLocale } from "@/i18n";
import { saveImage, shareImage } from "./imageActions";
import { assetImage, frameFit, imageAspect, type ImageAsset } from "./imageOutputs";
import { ImageSessionContext, openImageViewer, type ViewerImage } from "./imageViewer";
import { useConversation } from "./live";
import { useImageOutputs } from "./useImageOutputs";

export function ImageToolStill({ tool }: { tool: WorkActivityToolItem }) {
  const assets = useImageOutputs(tool.images);
  const session = useContext(ImageSessionContext);
  const { access, client } = useConversation();
  const copy = getAppCopy(useAppLocale());
  const t = useTokens();
  if (!assets.length || !access) return null;
  const shots = assets.map(asset => ({ source: assetImage(asset, access), alt: copy.conversation.answerBlocks.image,
    width: asset.width, height: asset.height,
    share: shareImage(access, asset.image_url, `${asset.id}.${asset.mime === "image/webp" ? "webp" : asset.mime === "image/jpeg" ? "jpg" : "png"}`, copy.conversation.answerBlocks.image, copy),
    save: client ? saveImage(client, asset.id, session, copy.conversation.answerBlocks.image, copy) : undefined }));
  return <View style={{ width: t.length("--layout-basis-xs"), maxWidth: "100%", gap: t.length("--space-md") }}>
    {assets.map((asset, index) => <ImageTile key={asset.id} asset={asset} access={access} shots={shots} index={index}
      label={copy.conversation.imageViewer.viewImage(copy.conversation.answerBlocks.image)} />)}
  </View>;
}

function ImageTile({ asset, access, shots, index, label }: {
  asset: ImageAsset; access: Access; shots: ViewerImage[]; index: number; label: string;
}) {
  const t = useTokens();
  const press = usePress({ scale: true });
  return <AnimatedPressable accessibilityRole="button" accessibilityLabel={label} {...press.handlers}
    onPress={() => openImageViewer(shots, index)} style={[press.scaleStyle, { opacity: press.opacity, borderRadius: TILE_RADIUS,
      boxShadow: press.focused ? t.shadow("--focus-ring") : undefined }]}>
    <ImageFrame source={assetImage(asset, access, 320)} aspect={imageAspect(asset.width, asset.height)} fit={frameFit(asset.width, asset.height)} />
  </AnimatedPressable>;
}
