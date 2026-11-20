import { useLocalSearchParams } from "expo-router";
import { ScrollEdgeEffectProvider } from "@bsky.app/expo-scroll-edge-effect";
import { ConversationScreen } from "@/conversation/ConversationScreen";

export default function Chat() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  return <ScrollEdgeEffectProvider><ConversationScreen key={id} id={id} title={title ?? ""} /></ScrollEdgeEffectProvider>;
}
