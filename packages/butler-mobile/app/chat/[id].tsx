import { useCallback } from "react";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { ScrollEdgeEffectProvider } from "@bsky.app/expo-scroll-edge-effect";
import { ConversationScreen } from "@/conversation/ConversationScreen";
import { clearOpenChat, setOpenChat } from "@/notifications/openChat";

export default function Chat() {
  const { id, title, text } = useLocalSearchParams<{ id: string; title?: string; text?: string }>();
  useFocusEffect(useCallback(() => {
    setOpenChat(id);
    return () => clearOpenChat(id);
  }, [id]));
  return <ScrollEdgeEffectProvider><ConversationScreen key={id} id={id} title={title ?? ""} initialText={text} /></ScrollEdgeEffectProvider>;
}
