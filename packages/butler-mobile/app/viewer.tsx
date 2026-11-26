import { Platform, Share } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useConversation } from "@/conversation/live";
import { IconButton, icons, showToast, Surface, useHeaderOptions } from "@/ds";
import { useMobileCopy } from "@/i18n";
import { shareFile, shareText } from "@/outputs/fileAccess";
import { markdownFileName, paramsTarget, type ViewerParams } from "@/outputs/results";
import { ViewerBody } from "@/outputs/ViewerBody";

export default function Viewer() {
  const target = paramsTarget(useLocalSearchParams<ViewerParams>());
  const { access, client } = useConversation();
  const M = useMobileCopy();
  const share = async () => {
    try {
      if (target.kind === "file") await shareFile(access!, `/message-files/${encodeURIComponent(target.id)}`, target.name, target.title);
      if (target.kind === "doc") {
        const { body } = await client!.request<{ body: string }>(`/documents/${encodeURIComponent(target.id)}`);
        await shareText(markdownFileName(target.title), body, target.title);
      }
      if (target.kind === "url") await Share.share({ message: target.url });
    } catch { showToast({ message: M.outputs.shareFailed, tone: "error" }); }
  };
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title: target.title, headerLargeTitle: false,
      ...(target.kind !== "output" ? Platform.OS === "ios" ? {
        unstable_headerRightItems: () => [{ type: "button", label: M.outputs.share,
          icon: { type: "sfSymbol", name: "square.and.arrow.up" }, onPress: share }],
      } : { headerRight: () => <IconButton icon={icons.Share} variant="ghost" label={M.outputs.share} onPress={share} /> } : {}) }} />
    <ViewerBody target={target} />
  </Surface>;
}
