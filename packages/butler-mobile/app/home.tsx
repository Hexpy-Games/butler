import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, LayoutAnimation, Platform, RefreshControl, ScrollView, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Badge, Button, ButtonGroup, EdgeFade, Icon, icons, ListRow, markdownPlainText, showToast, Spinner, Surface, Text, UnreadDot, useTokens } from "@/ds";
import { nativeFetch } from "@/connection/nativeFetch";
import { probe } from "@/connection/probe";
import type { Problem } from "@/connection/problems";
import { pairingStore } from "@/connection/store";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useReducedMotion } from "@/ds/internal/motion";

import { NewConversationSheet } from "@/conversation/NewConversationSheet";
import { RowActions } from "@/conversation/RowActions";
import { useConversation } from "@/conversation/live";
import { useNavigationView } from "@/conversation/useNavigationView";
import { spaceTree, visibleRows, type SpaceRow } from "@/conversation/space";
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
  if (status.kind === "ready") return <Conversations />;
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
  const t = useTokens();
  const { view, error, retry, refresh } = useNavigationView();
  const { lost } = useConversation();
  const [scrolled, setScrolled] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [actionRow, setActionRow] = useState<SpaceRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const tree = useMemo<ReturnType<typeof spaceTree>>(() => view ? spaceTree(view) : { children: new Map() }, [view]);
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
  const locale = useAppLocale();
  return <>
    {/* The list is the screen's root view: iOS ties the header to a scroll view only when nothing wraps it. */}
    <FlatList data={rows} keyExtractor={item => item.key} contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: t.color("--color-surface-base") }}
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal, paddingBottom: Platform.OS === "android" ? t.length("--control-hit-target") + 2 * t.length("--space-4") : undefined }}
      onScroll={event => setScrolled(event.nativeEvent.contentOffset.y > 0)} scrollEventThrottle={16}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={t.color("--text-secondary")} onRefresh={() => {
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
      }} />}
      renderItem={({ item }) => <View style={{ paddingLeft: item.depth * t.length("--space-4") }}>
        {item.session ? <SessionRow session={item.session} locale={locale} onLongPress={item.key === "s:general" ? undefined : () => setActionRow(item)} />
          : <ListRow icon={item.kind === "project" ? icons.Briefcase : icons.Folder} title={item.title}
            onLongPress={() => setActionRow(item)}
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
    <EdgeFade edge="top" visible={scrolled} />
    <RowActions row={actionRow} view={view} tree={tree} onClose={() => setActionRow(null)} onChanged={refresh} />
    <NewConversationSheet view={view} />
  </>;
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
