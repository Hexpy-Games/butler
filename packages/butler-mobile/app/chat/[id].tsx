import { useLocalSearchParams } from "expo-router";
import { ScrollEdgeEffectProvider } from "@bsky.app/expo-scroll-edge-effect";
import { ConversationScreen } from "@/conversation/ConversationScreen";

export default function Chat() {
  const { id, title, text } = useLocalSearchParams<{ id: string; title?: string; text?: string }>();
  return <ScrollEdgeEffectProvider><ConversationScreen key={id} id={id} title={title ?? ""} initialText={text} /></ScrollEdgeEffectProvider>;
}
