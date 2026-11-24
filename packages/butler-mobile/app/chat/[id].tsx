import { useLocalSearchParams } from "expo-router";
import { ScrollEdgeEffectProvider } from "@bsky.app/expo-scroll-edge-effect";
import { ConversationScreen } from "@/conversation/ConversationScreen";

export default function Chat() {
  const { id, title, text, computer_id, computer_name } = useLocalSearchParams<{ id: string; title?: string; text?: string; computer_id?: string; computer_name?: string }>();
  return <ScrollEdgeEffectProvider><ConversationScreen key={id} id={id} title={title ?? ""} initialText={text} computerRemoved={Boolean(computer_id && !computer_name)} /></ScrollEdgeEffectProvider>;
}
