import { useCallback, useRef, useState } from "react";
import { FlatList, Platform, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollEdgeEffectProvider, useScrollEdgeEffectRef } from "@bsky.app/expo-scroll-edge-effect";
import type { ConversationMessage, MessageSendRequest, SessionView } from "../../../butler-protocol/src/index.ts";
import { toMarkdown } from "../../../butler-protocol/src/answer-blocks-markdown.ts";
import { Button, ButtonGroup, Composer, ComposerDock, EdgeFade, Markdown, showToast, Spinner, Surface, Text, useHeaderInset, useHeaderOptions, useTokens } from "@/ds";
import { RADIUS } from "@/design/tokens";
import { useConversation } from "@/conversation/live";
import { SESSION_PAGE, useSessionView } from "@/conversation/useSessionView";
import { useMobileCopy } from "@/i18n";

export default function Chat() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  return <ScrollEdgeEffectProvider><ConversationScreen key={id} id={id} title={title ?? ""} /></ScrollEdgeEffectProvider>;
}

function ConversationScreen({ id, title }: { id: string; title: string }) {
  const copy = useMobileCopy();
  const t = useTokens();
  const options = useHeaderOptions();
  const headerInset = useHeaderInset();
  const { view, error, loadingEarlier, reload, loadEarlier } = useSessionView(id);
  const list = useRef<FlatList<ConversationMessage> | null>(null);
  const edgeRef = useScrollEdgeEffectRef();
  const ref = useCallback((node: FlatList<ConversationMessage> | null) => {
    list.current = node;
    if (typeof edgeRef === "function") edgeRef(node);
  }, [edgeRef]);
  const first = useRef(true);
  const count = useRef(0);
  const atBottom = useRef(true);
  const [bottom, setBottom] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);
  const messages = view?.messages.filter(message => message.role === "user"
    || (message.role === "assistant" && (message.text !== "" || !!message.answer_blocks?.length))) ?? [];
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...options, title, headerLargeTitle: false }} />
    {error ? <View style={{ flex: 1, justifyContent: "center", padding: t.length("--space-4"), gap: t.length("--space-4") }}>
      <Text tone="danger">{copy.chat.loadFailed}</Text>
      <ButtonGroup><Button label={copy.chat.retry} onPress={reload} /></ButtonGroup>
    </View> : <FlatList ref={ref} data={messages} keyExtractor={message => message.id}
      renderItem={({ item }) => <Message message={item} />}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      contentInsetAdjustmentBehavior="never" scrollIndicatorInsets={{ top: headerInset }} automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" scrollEventThrottle={16}
      contentContainerStyle={{ paddingHorizontal: t.length("--space-4"), paddingTop: headerInset + t.length("--space-4"), gap: t.length("--space-4") }}
      initialNumToRender={SESSION_PAGE}
      onStartReached={() => { if (!first.current) loadEarlier(); }} onStartReachedThreshold={0.5}
      onScroll={({ nativeEvent }) => {
        setBottom(nearEnd(nativeEvent));
        setScrolled(nativeEvent.contentOffset.y > 0);
      }}
      onScrollBeginDrag={() => { atBottom.current = false; }}
      onScrollToTop={() => { atBottom.current = false; }}
      onScrollEndDrag={({ nativeEvent }) => { atBottom.current = nearEnd(nativeEvent); }}
      onMomentumScrollEnd={({ nativeEvent }) => { atBottom.current = nearEnd(nativeEvent); }}
      onContentSizeChange={() => {
        if (!messages.length) return;
        if (first.current || atBottom.current) {
          list.current?.getNativeScrollRef()?.scrollToEnd({ animated: !first.current && messages.length !== count.current });
        }
        first.current = false;
        count.current = messages.length;
      }}
      ListHeaderComponent={loadingEarlier ? <Spinner label={copy.chat.earlier} /> : undefined}
      ListFooterComponent={<View style={{ paddingBottom: dockHeight }}>{view ? <TurnStatus view={view} /> : null}</View>}
    />}
    <EdgeFade edge="top" offset={headerInset} visible={scrolled} />
    <EdgeFade edge="bottom" offset={dockHeight} visible={!bottom} />
    <ChatComposer id={id} turn={view?.active_turn ?? null} onHeightChange={setDockHeight}
      onSend={() => { atBottom.current = true; setBottom(true); }} />
  </Surface>;
}

type ScrollMetrics = { contentSize: { height: number }; layoutMeasurement: { height: number }; contentOffset: { y: number } };
const nearEnd = ({ contentSize, layoutMeasurement, contentOffset }: ScrollMetrics) =>
  contentSize.height - layoutMeasurement.height - contentOffset.y < 48;

function Message({ message }: { message: ConversationMessage }) {
  const copy = useMobileCopy();
  const t = useTokens();
  if (message.role === "user") return <View style={{ alignSelf: "flex-end", maxWidth: "85%",
    backgroundColor: t.color("--user-message-bg"), borderRadius: t.length(RADIUS),
    paddingVertical: t.length("--space-3"), paddingHorizontal: t.length("--space-4") }}>
    <Text selectable>{message.text}</Text>
  </View>;
  const failed = message.status === "failed" || message.delivery_state === "system_error" || message.delivery_state === "failed_system";
  const cancelled = message.status === "cancelled" || message.delivery_state === "cancelled";
  return <View style={{ width: "100%", gap: t.length("--space-3") }}>
    <Markdown text={message.text} />
    {message.answer_blocks?.map((set, index) => <Markdown key={index} text={toMarkdown(set.spec, url => url)} />)}
    {failed ? <Text tone="danger">{copy.chat.failed}</Text> : null}
    {cancelled ? <Text tone="tertiary">{copy.chat.cancelled}</Text> : null}
  </View>;
}

function TurnStatus({ view }: { view: SessionView }) {
  const copy = useMobileCopy();
  const t = useTokens();
  const turn = view.active_turn;
  if (turn?.state === "waiting_for_form") return <Text tone="secondary">{copy.chat.waitingForYou}</Text>;
  const newest = view.messages.at(-1);
  if (!turn || !["queued", "accepted", "thinking", "streaming", "waiting_for_tool", "cancelling", "retrying"].includes(turn.state)
    || (newest?.role === "assistant" && newest.status === "streaming")) return null;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
    <Spinner label={copy.chat.thinking} />
    <Text tone="secondary">{turn.safe_status_label ?? copy.chat.thinking}</Text>
  </View>;
}

function ChatComposer({ id, turn, onHeightChange, onSend }: {
  id: string; turn: SessionView["active_turn"]; onHeightChange(height: number): void; onSend(): void;
}) {
  const copy = useMobileCopy();
  const { client } = useConversation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!client || busy || !text.trim()) return;
    onSend();
    setBusy(true);
    const body: MessageSendRequest = { chat_id: id, text: text.trim(),
      client_message_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      attachments: [], queue_policy: "send_now" };
    try {
      await client.request("/messages", { body });
      setText("");
    } catch {
      showToast({ message: copy.chat.sendFailed, tone: "error" });
    } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!client || busy || !turn) return;
    setBusy(true);
    try { await client.request(`/turns/${encodeURIComponent(turn.id)}/cancel`, { body: {} }); }
    catch { showToast({ message: copy.chat.stopFailed, tone: "error" }); }
    finally { setBusy(false); }
  };
  return <ComposerDock onHeightChange={onHeightChange}>
    <Composer value={text} onChangeText={setText} placeholder={copy.chat.placeholder} canSend={!!text.trim()}
      mode={turn?.cancellable ? "stop" : "send"} busy={busy} onSend={send} onStop={stop}
      sendLabel={copy.chat.send} stopLabel={copy.chat.stop} />
  </ComposerDock>;
}
