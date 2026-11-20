import { useCallback, useMemo, useRef, useState } from "react";
import { Animated, FlatList, LayoutAnimation, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollEdgeEffectProvider, useScrollEdgeEffectRef } from "@bsky.app/expo-scroll-edge-effect";
import { router, useFocusEffect } from "expo-router";
import { getAppCopy } from "../../butler-i18n/src/index.ts";
import type { EpicCard } from "../../butler-protocol/src/index.ts";
import { Badge, Button, ButtonGroup, GlassBackdrop, Icon, icons, ListRow, markdownPlainText, showToast, Spinner, Surface, Text, UnreadDot, useTokens } from "@/ds";
import { nativeFetch } from "@/connection/nativeFetch";
import { probe } from "@/connection/probe";
import type { Problem } from "@/connection/problems";
import { pairingStore } from "@/connection/store";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useReducedMotion } from "@/ds/internal/motion";

import { HomeHeader, HOME_HEADER_ROW } from "@/conversation/HomeHeader";
import { NewConversationSheet } from "@/conversation/NewConversationSheet";
import { RowActions } from "@/conversation/RowActions";
import { useConversation } from "@/conversation/live";
import { useNavigationView } from "@/conversation/useNavigationView";
import { useCanonSidebars } from "@/conversation/useCanonSidebars";
import { spaceTree, visibleRows, withCanon, type SpaceRow } from "@/conversation/space";
import { sessionMark, timeLabel } from "@/conversation/sessions";

type Status = { kind: "checking"; origin?: string } | { kind: "ready"; origin: string } | { kind: "problem"; origin: string; problem: Problem };

export default function Home() {
  const copy = useMobileCopy();
  const t = useTokens();
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const latest = useRef(0);
  const { connect } = useConversation();
  const check = useCallback(async () => {
    const id = ++latest.current;
    setStatus(previous => previous.kind === "ready" ? previous : { kind: "checking", origin: previous.origin });
    const pairing = await pairingStore.loadActive().catch(() => null);
    if (!pairing) {
      if (id !== latest.current) return;
      router.replace("/pair");
      return;
    }
    const result = await probe(pairing.origin, pairing.deviceToken, nativeFetch);
    if (result.kind === "problem" && result.problem === "needsPairing") {
      if (id !== latest.current) return;
      await pairingStore.clear(pairing.butlerId);
      if (id !== latest.current) return;
      showToast({ message: copy.problems.needsPairing, tone: "warning" });
      if (id !== latest.current) return;
      router.replace("/pair");
      return;
    }
    if (id !== latest.current) return;
    if (result.kind === "ready") connect(pairing);
    setStatus(result.kind === "ready"
      ? { kind: "ready", origin: pairing.origin }
      : { kind: "problem", origin: pairing.origin, problem: result.problem });
  }, [copy, connect]);
  useFocusEffect(useCallback(() => {
    void check();
    return () => { latest.current++; };
  }, [check]));
  if (status.kind === "ready") return <ScrollEdgeEffectProvider><Conversations /></ScrollEdgeEffectProvider>;
  return (
    <Surface variant="base" grow edges={["top", "bottom", "left", "right"]} padding="lg">
      <View style={{ flex: 1, gap: t.length("--space-4") }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: t.length("--space-4") }}>
          <Text variant="h1">{copy.appName}</Text>
          {status.origin ? <Text tone="secondary" literal selectable>{status.origin}</Text> : null}
          {status.kind === "checking" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
              <Spinner label={copy.home.checking} />
              <Text tone="secondary">{copy.home.checking}</Text>
            </View>
          ) : null}
          {status.kind === "problem" ? <Text tone="danger">{copy.problems[status.problem]}</Text> : null}
        </ScrollView>
        <ButtonGroup>
          {status.kind === "problem" ? <Button label={copy.home.retry} onPress={check} /> : null}
          <Button variant="secondary" label={copy.home.pairAgain} onPress={() => router.push("/pair")} />
        </ButtonGroup>
      </View>
    </Surface>
  );
}

function Conversations() {
  const copy = useMobileCopy();
  const locale = useAppLocale();
  const appCopy = getAppCopy(locale);
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const edgeRef = useScrollEdgeEffectRef();
  const { view, error, retry, refresh } = useNavigationView();
  const { lost } = useConversation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [actionRow, setActionRow] = useState<SpaceRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sidebars = useCanonSidebars(useMemo(() => view?.projects.filter(project => !project.archived && !collapsed.has(`p:${project.id}`)).map(project => project.id) ?? [], [view, collapsed]));
  const tree = useMemo<ReturnType<typeof spaceTree>>(() => view ? withCanon(spaceTree(view), sidebars, appCopy.canon.backlog) : { children: new Map() }, [view, sidebars, appCopy]);
  const rows: SpaceRow[] = visibleRows(tree, collapsed);
  if (tree.general) rows.unshift({ key: "s:general", kind: "session", title: tree.general.title, session: tree.general, depth: 0 });
  const reduced = useReducedMotion();
  const toggle = (key: string) => {
    const expanding = collapsed.has(key);
    // Rows slide and fade with the desktop collapse timing (--motion-base in, --motion-exit-base out).
    if (!reduced) LayoutAnimation.configureNext({
      duration: t.duration(expanding ? "--motion-base" : "--motion-exit-base"),
      create: { type: "easeOut", property: "opacity" },
      update: { type: expanding ? "easeOut" : "easeIn" },
      delete: { type: "easeIn", property: "opacity" },
    });
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const unread = useMemo(() => {
    const keys = new Set<string>();
    const visit = (parent: string | null): boolean => {
      let found = false;
      for (const row of tree.children.get(parent) ?? []) {
        const descendant = visit(row.key);
        if (descendant) keys.add(row.key);
        found = found || !!row.session?.unread || descendant;
      }
      return found;
    };
    visit(null);
    return keys;
  }, [tree]);
  const paddingHorizontal = t.length("--space-4");
  return <>
    <GlassBackdrop overlay={<HomeHeader scrollY={scrollY} title={copy.conversations.title} settingsLabel={appCopy.sidebar.settings} onSettings={() => router.push("/settings")} />}>
    <Animated.FlatList data={rows} keyExtractor={item => item.key} contentInsetAdjustmentBehavior="never"
      ref={(node: FlatList<SpaceRow> | null) => { if (typeof edgeRef === "function") edgeRef(node); }}
      style={{ backgroundColor: t.color("--color-surface-base") }}
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal, paddingTop: insets.top + HOME_HEADER_ROW, paddingBottom: insets.bottom + t.length("--control-hit-target") + 2 * t.length("--space-4") }}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })} scrollEventThrottle={16}
      refreshControl={<RefreshControl refreshing={refreshing} progressViewOffset={insets.top + HOME_HEADER_ROW} tintColor={t.color("--text-secondary")} onRefresh={() => {
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
      }} />}
      renderItem={({ item }) => <View style={{ paddingLeft: item.depth * t.length("--space-4") }}>
        {item.session ? <SessionRow session={item.session} locale={locale} onLongPress={item.key === "s:general" ? undefined : () => setActionRow(item)} />
          : item.kind === "epic" ? <EpicRow epic={item.epic!} />
          : <ListRow icon={item.kind === "project" ? icons.Briefcase : item.kind === "plan" ? icons.Flag : icons.Folder} title={item.title}
            onLongPress={item.kind === "plan" || item.kind === "backlog" ? undefined : () => setActionRow(item)}
            {...((tree.children.get(item.key)?.length ?? 0) > 0 ? {
              disclosure: { expanded: !collapsed.has(item.key) },
              onPress: () => toggle(item.key),
              accessibilityLabel: (collapsed.has(item.key) ? copy.conversations.expand : copy.conversations.collapse)(item.title),
            } : {})}
            trailing={collapsed.has(item.key) && unread.has(item.key) ? <UnreadDot label={copy.conversations.unread} /> : undefined} />}
      </View>}
      ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: t.length("--space-4") }}>
        {view ? <Text tone="secondary">{copy.conversations.empty}</Text>
          : error ? <>
            <Text tone="danger">{copy.conversations.loadFailed}</Text>
            <ButtonGroup><Button label={copy.home.retry} onPress={retry} /></ButtonGroup>
          </> : <Spinner label={copy.home.checking} />}
      </View>}
      ListHeaderComponent={lost ? <Text variant="caption" tone="tertiary">{copy.conversations.reconnecting}</Text> : undefined}
    />
    </GlassBackdrop>
    <RowActions row={actionRow} view={view} tree={tree} onClose={() => setActionRow(null)} onChanged={refresh} />
    <NewConversationSheet view={view} />
  </>;
}

function EpicRow({ epic }: { epic: EpicCard }) {
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const { client } = useConversation();
  const t = useTokens();
  const running = epic.running || epic.queue?.state === "running";
  const open = async () => {
    try {
      const id = epic.home_session_id ?? (await client!.request<{ session_id: string }>(`/canon/epics/${encodeURIComponent(epic.id)}/conversation`, { body: {} })).session_id;
      router.push({ pathname: "/chat/[id]", params: { id, title: epic.title } });
    } catch { showToast({ message: appCopy.canon.conversationFailed, tone: "warning" }); }
  };
  return <ListRow icon={icons.Ticket} title={epic.title} onPress={() => void open()}
    trailing={<View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
      {running ? <Spinner label={copy.conversations.working} /> : null}
      <Icon glyph={icons.ChevronRight} tone="tertiary" />
    </View>} />;
}

function SessionRow({ session, locale, onLongPress }: { session: NonNullable<SpaceRow["session"]>; locale: string; onLongPress?: () => void }) {
  const copy = useMobileCopy();
  const t = useTokens();
  const title = session.title.trim() ? session.title : copy.conversations.untitled;
  const mark = sessionMark(session);
  return <ListRow icon={session.project_id && session.id !== "general" ? icons.Notebook : icons.MessageSquare}
    title={title} description={session.last_message_preview ? markdownPlainText(session.last_message_preview) : undefined}
    descriptionLines={1} meta={timeLabel(session.last_activity_at, locale, new Date())} onLongPress={onLongPress}
    trailing={<View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
      {mark === "attention" ? <Badge tone="warning" label={copy.conversations.needsAttention} />
        : mark === "working" ? <Spinner label={copy.conversations.working} />
        : mark === "unread" ? <UnreadDot label={copy.conversations.unread} /> : null}
      <Icon glyph={icons.ChevronRight} tone="tertiary" />
    </View>} onPress={() => router.push({ pathname: "/chat/[id]", params: { id: session.id, title } })} />;
}
