import { View } from "react-native";
import type { ConversationMessage } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { Pairing } from "@/connection/pairings";
import { useConversation } from "@/conversation/live";
import { frameFit, imageAspect } from "@/conversation/imageOutputs";
import { ImageFrame, ListGroup, useTokens } from "@/ds";
import { TILE_RADIUS } from "@/ds/AttachmentTiles";
import { AnimatedPressable, usePress } from "@/ds/internal/press";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { artifactTarget, messageResults, type ResultTarget } from "./results";
import { fileSource } from "./fileAccess";
import { openResult } from "./openResult";
import { ResultRow } from "./ResultRow";

export function MessageResults({ message }: { message: ConversationMessage }) {
  const { pairing } = useConversation();
  const t = useTokens();
  if (!pairing) return null;
  const results = messageResults(message);
  if (!results.length) return null;
  const images = results.filter(a => artifactTarget(a)?.kind === "image");
  const files = results.filter(a => artifactTarget(a)?.kind !== "image");
  return <>
    {images.length > 0 ? <View style={{ width: t.length("--layout-basis-xs"), maxWidth: "100%", gap: t.length("--space-md") }}>
      {images.map(a => {
        const file = message.attachments?.find(f => f.file_id === a.file_id);
        return <ImageTile key={a.id} target={artifactTarget(a) as Extract<ResultTarget, { kind: "image" }>}
          pairing={pairing} width={file?.width ?? 0} height={file?.height ?? 0} />;
      })}
    </View> : null}
    {files.length ? <ListGroup>{files.map(a => <ResultRow key={a.id} artifact={a} />)}</ListGroup> : null}
  </>;
}

function ImageTile({ target, pairing, width, height }: { target: Extract<ResultTarget, { kind: "image" }>; pairing: Pairing; width: number; height: number }) {
  const app = getAppCopy(useAppLocale()), M = useMobileCopy();
  const t = useTokens(), press = usePress({ scale: true });
  return <AnimatedPressable accessibilityRole="button" accessibilityLabel={app.conversation.imageViewer.viewImage(target.title)} {...press.handlers}
    onPress={() => openResult(target, pairing, M.outputs.loadFailed)} style={[press.scaleStyle, { opacity: press.opacity, borderRadius: TILE_RADIUS,
      boxShadow: press.focused ? t.shadow("--focus-ring") : undefined }]}>
    <ImageFrame source={fileSource(pairing, target.path)} aspect={imageAspect(width, height)} fit={frameFit(width, height)} />
  </AnimatedPressable>;
}
