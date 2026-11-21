import { useLocalSearchParams } from "expo-router";
import { ScrollEdgeEffectProvider } from "@bsky.app/expo-scroll-edge-effect";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { ConversationScreen } from "@/conversation/ConversationScreen";
import { useAppLocale } from "@/i18n";

export default function NewChat() {
  const { project, group, text } = useLocalSearchParams<{ project?: string; group?: string; text?: string }>();
  const copy = getAppCopy(useAppLocale());
  return <ScrollEdgeEffectProvider><ConversationScreen project={project} group={group} initialText={text}
    title={project ? copy.sidebar.newProjectChat : copy.space.newChat} /></ScrollEdgeEffectProvider>;
}
