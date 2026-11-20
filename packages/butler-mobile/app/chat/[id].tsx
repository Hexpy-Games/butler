import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Platform, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollEdgeEffectProvider, useScrollEdgeEffectRef } from "@bsky.app/expo-scroll-edge-effect";
import type { ConversationMessage, MessageSendRequest, SessionView } from "../../../butler-protocol/src/index.ts";
import { toMarkdown } from "../../../butler-protocol/src/answer-blocks-markdown.ts";
import { RADIUS } from "@/design/tokens";
import { reasoningEffortLabel } from "../../../butler-i18n/src/reasoning-effort.ts";
import { AttachmentTiles, Button, ButtonGroup, Composer, ComposerDock, ContextRing, EdgeFade, IconButton, icons, ListRow, Markdown, Sheet, showToast, Spinner, Surface, Text, useHeaderInset, useHeaderOptions, useTokens } from "@/ds";
import { useConversation } from "@/conversation/live";
import { SESSION_PAGE, useSessionView } from "@/conversation/useSessionView";
import { useAppLocale, useMobileCopy } from "@/i18n";

import { pendingDecision, withQuestionAnswers, type ConversationRow, type PendingDecision } from "@/conversation/approval";
import { ApprovalCard, BrowserHandoffCard } from "@/conversation/ApprovalCard";
import { QuestionAnswerCard, QuestionCard } from "@/conversation/QuestionCard";
import { ContextBody, SessionInfoSheet } from "@/conversation/SessionInfoSheet";
import { ModelSheet } from "@/conversation/ModelSheet";
import { useAttachments } from "@/conversation/useAttachments";
import { useControls } from "@/conversation/useControls";

export default function Chat() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  return <ScrollEdgeEffectProvider><ConversationScreen key={id} id={id} title={title ?? ""} /></ScrollEdgeEffectProvider>;
}

function ConversationScreen({ id, title }: { id: string; title: string }) {
  const copy = useMobileCopy();
  const t = useTokens();
  const options = useHeaderOptions();
  const headerInset = useHeaderInset();
  const [infoOpen, setInfoOpen] = useState(false);
  const { view, error, loadingEarlier, reload, loadEarlier } = useSessionView(id);
  const list = useRef<FlatList<ConversationRow> | null>(null);
  const edgeRef = useScrollEdgeEffectRef();
  const ref = useCallback((node: FlatList<ConversationRow> | null) => {
    list.current = node;
    if (typeof edgeRef === "function") edgeRef(node);
  }, [edgeRef]);
  const first = useRef(true);
  const count = useRef(0);
  const atBottom = useRef(true);
  const [bottom, setBottom] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);
  const rows = withQuestionAnswers(view?.messages ?? [], view?.question_answers ?? [], message => message.role === "user"
    || (message.role === "assistant" && (message.text !== "" || !!message.answer_blocks?.length)));
  const decision = view ? pendingDecision(view) : null;
  useEffect(() => {
    if (atBottom.current && rows.length) {
      requestAnimationFrame(() => list.current?.getNativeScrollRef()?.scrollToEnd({ animated: true }));
    }
  }, [dockHeight]);
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...options, title, headerLargeTitle: false,
      ...(Platform.OS === "ios" ? {
        unstable_headerRightItems: () => [{ type: "button", label: copy.chat.info,
          icon: { type: "sfSymbol", name: "info.circle" }, onPress: () => setInfoOpen(true) }],
      } : { headerRight: () => <IconButton icon={icons.Info} variant="ghost" label={copy.chat.info} onPress={() => setInfoOpen(true)} /> }) }} />
    <SessionInfoSheet open={infoOpen} onClose={() => setInfoOpen(false)} id={id} title={title} view={view} />
    {error ? <View style={{ flex: 1, justifyContent: "center", padding: t.length("--space-4"), gap: t.length("--space-4") }}>
      <Text tone="danger">{copy.chat.loadFailed}</Text>
      <ButtonGroup><Button label={copy.chat.retry} onPress={reload} /></ButtonGroup>
    </View> : <FlatList ref={ref} data={rows} keyExtractor={message => message.id}
      renderItem={({ item }) => "questionAnswer" in item ? <QuestionAnswerCard answer={item.questionAnswer} /> : <Message message={item} latestTurn={view?.latest_turn} />}
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
        if (!rows.length) return;
        if (first.current || atBottom.current) {
          list.current?.getNativeScrollRef()?.scrollToEnd({ animated: !first.current && rows.length !== count.current });
        }
        first.current = false;
        count.current = rows.length;
      }}
      ListHeaderComponent={loadingEarlier ? <Spinner label={copy.chat.earlier} /> : undefined}
      ListFooterComponent={<View style={{ paddingBottom: dockHeight, gap: t.length("--space-4") }}>
        {view ? <TurnStatus view={view} hasDecision={!!decision} /> : null}
        {view && decision ? <PendingRequest decision={decision} view={view} reload={reload} /> : null}
      </View>}
    />}
    <EdgeFade edge="top" offset={headerInset} visible={scrolled} />
    <EdgeFade edge="bottom" offset={dockHeight} visible={!bottom} />
    <ChatComposer id={id} view={view} hasDecision={!!decision} onHeightChange={setDockHeight}
      onSend={() => { atBottom.current = true; setBottom(true); }} />
  </Surface>;
}

function PendingRequest({ decision, view, reload }: { decision: PendingDecision; view: SessionView; reload(): void }) {
  if (decision.kind === "question") return <QuestionCard key={decision.request.request_ref} request={decision.request} sessionId={view.session_id} reload={reload} />;
  if (decision.kind === "handoff") return <BrowserHandoffCard key={decision.card.requestRef} card={decision.card} turn={view.active_turn} reload={reload} />;
  return <ApprovalCard key={decision.card.requestRef} card={decision.card} count={decision.count} sessionId={view.session_id} reload={reload} />;
}

type ScrollMetrics = { contentSize: { height: number }; layoutMeasurement: { height: number }; contentOffset: { y: number } };
const nearEnd = ({ contentSize, layoutMeasurement, contentOffset }: ScrollMetrics) =>
  contentSize.height - layoutMeasurement.height - contentOffset.y < 48;

function TurnStatus({ view, hasDecision }: { view: SessionView; hasDecision: boolean }) {
  const copy = useMobileCopy();
  const t = useTokens();
  const turn = view.active_turn;
  if (turn?.state === "waiting_for_form") return hasDecision ? null : <Text tone="secondary">{copy.chat.waitingForYou}</Text>;
  const newest = view.messages.at(-1);
  if (!turn || !["queued", "accepted", "thinking", "streaming", "waiting_for_tool", "cancelling", "retrying"].includes(turn.state)
    || (newest?.role === "assistant" && newest.status === "streaming")) return null;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
    <Spinner label={copy.chat.thinking} />
    <Text tone="secondary">{turn.safe_status_label ?? copy.chat.thinking}</Text>
  </View>;
}

function ChatComposer({ id, view, hasDecision, onHeightChange, onSend }: {
  id: string; view: SessionView | null; hasDecision: boolean; onHeightChange(height: number): void; onSend(): void;
}) {
  const copy = useMobileCopy();
  const { client } = useConversation();
  const locale = useAppLocale();
  const attachments = useAttachments(id);
  const model = useControls(id);
  const [sheet, setSheet] = useState<"attach" | "model" | "context" | null>(null);
  const turn = view?.active_turn;
  const ready = attachments.items.flatMap(item => item.status === "ready" && item.file ? [item.file] : []);
  const uploading = attachments.items.some(item => item.status === "uploading");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !hasDecision;
  const send = async () => {
    if (!client || busy || !canSend) return;
    onSend();
    setBusy(true);
    const keys = attachments.items.filter(item => item.status === "ready" && item.file).map(item => item.key);
    const body: MessageSendRequest = { chat_id: id, text: text.trim(),
      client_message_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      attachments: ready.map(file => ({ file_id: file.file_id })), queue_policy: "send_now" };
    try {
      await client.request("/messages", { body });
      setText("");
      attachments.removeMany(keys);
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
    <Composer value={text} onChangeText={setText} placeholder={copy.chat.placeholder} canSend={canSend}
      mode={turn?.cancellable ? "stop" : "send"} busy={busy} onSend={send} onStop={stop}
      sendLabel={copy.chat.send} stopLabel={copy.chat.stop} attach={{ label: copy.chat.attach, onPress: () => setSheet("attach") }}
      attachments={attachments.items.length ? <AttachmentTiles layout="row" items={attachments.items.map(item => ({
        key: item.key, name: item.name, kind: item.kind, image: item.kind === "image" ? { uri: item.uri } : undefined,
        extension: item.name.trim().match(/\.([^.]+)$/)?.[1]?.toUpperCase() || copy.chat.fileLabel,
        upload: item.status === "ready" ? undefined : item.status,
      }))} onRemove={attachments.remove} removeLabel={copy.chat.removeAttachment}
        uploadingLabel={copy.chat.uploading} failedLabel={copy.chat.uploadFailed} /> : null}
      leading={model.controls ? <Button variant="ghost" iconEnd={icons.ChevronDown} onPress={() => setSheet("model")}
        label={`${model.current?.display_name ?? model.controls.model} · ${reasoningEffortLabel(model.controls.reasoning_effort, locale)}`} /> : null}
      trailing={view?.context ? <ContextRing ratio={view.context.ratio} label={copy.chat.contextUsed(Math.round(view.context.ratio * 100))}
        onPress={() => setSheet("context")} /> : null} />
    <ModelSheet {...model} open={sheet === "model"} onClose={() => setSheet(null)} />
    <Sheet open={sheet === "context"} onClose={() => setSheet(null)} title={copy.chat.context} cancelLabel={copy.chat.close}>
      {view?.context ? <ContextBody context={view.context} /> : null}
    </Sheet>
    <Sheet open={sheet === "attach"} onClose={() => setSheet(null)} title={copy.chat.attach} cancelLabel={copy.chat.close}>
      {model.current?.image_input_support !== "unsupported" ? <ListRow icon={icons.Image} title={copy.chat.attachPhoto}
        onPress={() => { setSheet(null); void attachments.pick("photo"); }} /> : null}
      <ListRow icon={icons.File} title={copy.chat.attachFile} onPress={() => { setSheet(null); void attachments.pick("file"); }} />
    </Sheet>
  </ComposerDock>;
}

function Message({ message, latestTurn }: { message: ConversationMessage; latestTurn?: SessionView["latest_turn"] }) {
  const copy = useMobileCopy();
  const t = useTokens();
  const { pairing } = useConversation();
  if (message.role === "user") return <View style={{ alignSelf: "flex-end", maxWidth: "85%", gap: t.length("--space-1") }}>
    {message.text ? <View style={{ backgroundColor: t.color("--user-message-bg"), borderRadius: t.length(RADIUS),
      paddingVertical: t.length("--space-3"), paddingHorizontal: t.length("--space-4") }}>
      <Text selectable>{message.text}</Text>
    </View> : null}
    {message.attachments?.length ? <AttachmentTiles layout="wrap" items={message.attachments.map(file => ({
      key: file.file_id, name: file.safe_name, kind: file.kind === "image" || file.mime_type.startsWith("image/") ? "image" : "file",
      image: pairing && (file.kind === "image" || file.mime_type.startsWith("image/"))
        ? { uri: new URL(file.url, pairing.origin).href, headers: { Authorization: `Bearer ${pairing.deviceToken}` } } : undefined,
      extension: file.safe_name.trim().match(/\.([^.]+)$/)?.[1]?.toUpperCase() || copy.chat.fileLabel,
      meta: file.size_bytes < 1024 * 1024 ? `${Math.round(file.size_bytes / 1024)} KB` : `${(file.size_bytes / (1024 * 1024)).toFixed(1)} MB`,
    }))} uploadingLabel={copy.chat.uploading} failedLabel={copy.chat.uploadFailed} /> : null}
    <MessageInfo message={message} />
  </View>;
  const failed = message.status === "failed" || message.delivery_state === "system_error" || message.delivery_state === "failed_system";
  const cancelled = message.status === "cancelled" || message.delivery_state === "cancelled";
  return <View style={{ width: "100%", gap: t.length("--space-1") }}>
    <View style={{ gap: t.length("--space-3") }}>
      <Markdown text={message.text} />
      {message.answer_blocks?.map((set, index) => <Markdown key={index} text={toMarkdown(set.spec, url => url)} />)}
      {failed ? <Text tone="danger">{copy.chat.failed}</Text> : null}
      {cancelled ? <Text tone="tertiary">{copy.chat.cancelled}</Text> : null}
    </View>
    {message.status !== "streaming" ? <MessageInfo message={message}
      retryable={failed && message.turn_id === latestTurn?.id && latestTurn?.retryable} /> : null}
  </View>;
}

function MessageInfo({ message, retryable }: { message: ConversationMessage; retryable?: boolean }) {
  const [retrying, setRetrying] = useState(false);
  const copy = useMobileCopy();
  const locale = useAppLocale();
  const t = useTokens();
  const { client } = useConversation();
  const user = message.role === "user";
  const timestamp = user ? message.created_at : message.updated_at ?? message.created_at;
  const time = timestamp ? <Text variant="caption" tone="tertiary">
    {new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}
  </Text> : null;
  const copyText = async () => {
    const text = user ? message.text : [message.text, ...(message.answer_blocks ?? []).map(set => toMarkdown(set.spec, url => url))].join("\n\n");
    await Clipboard.setStringAsync(text);
    showToast({ message: copy.chat.copied, tone: "success" });
  };
  const retry = async () => {
    setRetrying(true);
    try { await client?.request(`/turns/${encodeURIComponent(message.turn_id!)}/retry`, { body: {} }); }
    catch { showToast({ message: copy.chat.retryFailed, tone: "error" }); }
    finally { setRetrying(false); }
  };
  return <View style={{ flexDirection: "row", alignItems: "center", justifyContent: user ? "flex-end" : "flex-start", gap: t.length("--space-1") }}>
    {retryable ? <Button variant="secondary" iconStart={icons.Retry} label={copy.chat.retry} onPress={retry} disabled={retrying} /> : null}
    {user ? time : null}
    <IconButton icon={icons.Copy} variant="ghost" size="sm" label={copy.chat.copy} onPress={copyText} />
    {user ? null : time}
  </View>;
}
