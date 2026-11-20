import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Platform, View } from "react-native";
import { Stack } from "expo-router";
import { useScrollEdgeEffectRef } from "@bsky.app/expo-scroll-edge-effect";
import type { SessionView } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, ButtonGroup, EdgeFade, IconButton, icons, Spinner, Surface, Text, useHeaderInset, useHeaderOptions, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { pendingDecision, withQuestionAnswers, type ConversationRow, type PendingDecision } from "./approval";
import { ApprovalCard, BrowserHandoffCard } from "./ApprovalCard";
import { QuestionAnswerCard, QuestionCard } from "./QuestionCard";
import { SessionInfoSheet } from "./SessionInfoSheet";
import { SESSION_PAGE, useSessionView } from "./useSessionView";
import { ChatComposer } from "./ChatComposer";
import { Message, UserMessage } from "./Message";
import { useSessionQueue } from "./useSessionQueue";
import { queuedConversationItems } from "./queue";
import { QueuedMessageItem } from "./QueuedMessageItem";

export function ConversationScreen({ id, title, project, group, initialText = "" }: {
  id?: string; title: string; project?: string; group?: string; initialText?: string;
}) {
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const t = useTokens();
  const options = useHeaderOptions();
  const [infoOpen, setInfoOpen] = useState(false);
  const session = useSessionView(id);
  const { view, error, reload } = session;
  const queue = useSessionQueue(id, view);
  const [text, setText] = useState(initialText);
  const [pending, setPending] = useState<string | null>(null);
  const [dockHeight, setDockHeight] = useState(0);
  const [sends, setSends] = useState(0);
  const decision = view ? pendingDecision(view) : null;
  const hasDecision = !!decision && (decision.kind !== "question" || decision.request.question_state === "pending");
  const items = queuedConversationItems(queue.view?.queued_messages ?? [], view?.messages ?? []);
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...options, title, headerLargeTitle: false,
      ...(id ? Platform.OS === "ios" ? {
        unstable_headerRightItems: () => [{ type: "button", label: copy.chat.info,
          icon: { type: "sfSymbol", name: "info.circle" }, onPress: () => setInfoOpen(true) }],
      } : { headerRight: () => <IconButton icon={icons.Info} variant="ghost" label={copy.chat.info} onPress={() => setInfoOpen(true)} /> } : {}) }} />
    {id ? <SessionInfoSheet open={infoOpen} onClose={() => setInfoOpen(false)} id={id} title={title} view={view} /> : null}
    {error ? <View style={{ flex: 1, justifyContent: "center", padding: t.length("--space-4"), gap: t.length("--space-4") }}>
      <Text tone="danger">{copy.chat.loadFailed}</Text>
      <ButtonGroup><Button label={copy.chat.retry} onPress={reload} /></ButtonGroup>
    </View> : <ConversationMessages {...session} dockHeight={dockHeight} sends={sends}>
      {pending !== null ? <UserMessage message={{ text: pending }}>
        <Text variant="caption" tone="tertiary">{appCopy.sidebar.newSessionStarting}</Text>
      </UserMessage> : null}
      {items.map(item => <QueuedMessageItem key={item.key} item={item} onEdit={setText} refresh={queue.refresh} />)}
      {view ? <TurnStatus view={view} hasDecision={hasDecision} /> : null}
      {view && decision ? <PendingRequest decision={decision} view={view} reload={reload} /> : null}
    </ConversationMessages>}
    <ChatComposer id={id} project={project} group={group} view={view} hasDecision={hasDecision}
      text={text} setText={setText} onPending={setPending} refreshQueue={queue.refresh} onHeightChange={setDockHeight}
      onSend={() => setSends(value => value + 1)} />
  </Surface>;
}

function ConversationMessages({ view, loadingEarlier, loadEarlier, dockHeight, sends, children }: {
  view: SessionView | null; loadingEarlier: boolean; loadEarlier(): void;
  dockHeight: number; sends: number; children: React.ReactNode;
}) {
  const copy = useMobileCopy();
  const t = useTokens();
  const headerInset = useHeaderInset();
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
  const rows = withQuestionAnswers(view?.messages ?? [], view?.question_answers ?? [], message => message.role === "user"
    || (message.role === "assistant" && (message.text !== "" || !!message.answer_blocks?.length)));
  useEffect(() => { atBottom.current = true; setBottom(true); }, [sends]);
  useEffect(() => {
    if (atBottom.current && rows.length) {
      requestAnimationFrame(() => list.current?.getNativeScrollRef()?.scrollToEnd({ animated: true }));
    }
  }, [dockHeight]);
  return <>
    <FlatList ref={ref} data={rows} keyExtractor={message => message.id}
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
      ListFooterComponent={<View style={{ paddingBottom: dockHeight, gap: t.length("--space-4") }}>{children}</View>}
    />
    <EdgeFade edge="top" offset={headerInset} visible={scrolled} />
    <EdgeFade edge="bottom" offset={dockHeight} visible={!bottom} />
  </>;
}

function PendingRequest({ decision, view, reload }: { decision: PendingDecision; view: SessionView; reload(): void }) {
  if (decision.kind === "question") return <QuestionCard key={decision.request.request_ref} request={decision.request} sessionId={view.session_id} reload={reload} />;
  if (decision.kind === "handoff") return <BrowserHandoffCard key={decision.card.requestRef} card={decision.card} sessionId={view.session_id} turn={view.active_turn} reload={reload} />;
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
