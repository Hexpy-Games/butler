import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { TabStrip, type TabStripProps } from "./TabStrip";
import type { TabStripLabels } from "./tabStripLabels";
import { applyTabStripMove, type TabStripGroup, type TabStripTab } from "./tabStripModel";

type AppLocale = ShowcaseRenderContext["locale"];

/** Korean copy as the App container would pass it (English is the block default). */
export const TAB_STRIP_LABELS_KO: TabStripLabels = {
  tabs: "탭", myTabs: "내 탭", newTab: "새 탭", closeTab: "탭 닫기", untitled: "제목 없음", loading: "불러오는 중",
  working: "버틀러 작업 중", waiting: "승인 대기", crashed: "페이지 종료됨",
  tabCount: (count) => `탭 ${count}개`, newTabIn: (group) => `${group}에 새 탭`, moreTabs: (count) => `+${count}`,
  moved: (title, group, position) => `${title}: ${group}, ${position}번째`,
};

export const demoLabels = (locale: AppLocale) => (locale === "ko-KR" ? TAB_STRIP_LABELS_KO : undefined);

/** A 16px site icon as a data URI (no network in the viewer). */
function favicon(color: string, letter: string) {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23${color}'/%3E%3Ctext x='8' y='11.5' font-size='9' font-weight='700' text-anchor='middle' fill='%23fafafa' font-family='sans-serif'%3E${letter}%3C/text%3E%3C/svg%3E`;
}

export const ICONS = { docs: favicon("3b6fd8", "D"), mail: favicon("d9473b", "M"), shop: favicon("1f8f5f", "S"), map: favicon("8a5cf6", "K"), broken: "data:image/png;base64,broken" };

const COPY = {
  "en-US": {
    mine: ["Butler design system", "Inbox — Mail", "Q3 report.pdf"], shoes: "Running shoes under $150", trip: "Book a Busan trip",
    shop: ["Search results — Shop", "Checkout", "Size guide", "Reviews"], sync: "Order sync", syncTab: "Seller console",
    tripTabs: ["Hotel booking", "Train timetable", "Beach weather", "Seafood market", "Car rental"],
  },
  "ko-KR": {
    mine: ["버틀러 디자인 시스템", "받은편지함 — 메일", "3분기 보고서.pdf"], shoes: "15만 원 이하 러닝화", trip: "부산 여행 예약",
    shop: ["검색 결과 — 쇼핑", "결제", "사이즈 가이드", "구매 후기"], sync: "주문 동기화", syncTab: "판매자 콘솔",
    tripTabs: ["호텔 예약", "KTX 시간표", "해운대 날씨", "자갈치 시장", "렌터카"],
  },
} as const;

function shoesGroup(locale: AppLocale, size = 2): TabStripGroup {
  const copy = COPY[locale];
  const tabs: TabStripTab[] = copy.shop.slice(0, size).map((title, index) => ({ id: `s${index + 1}`, title, faviconSrc: ICONS.shop }));
  tabs[0] = { ...tabs[0]!, state: "working" };
  return { id: "shoes", kind: "conversation", label: copy.shoes, state: "working", tabs };
}

/** A folded group of five tabs: its title previews three favicons and "+2". */
function tripGroup(locale: AppLocale): TabStripGroup {
  const icons = [ICONS.map, ICONS.broken, ICONS.docs, ICONS.mail, ICONS.shop];
  return { id: "trip", kind: "conversation", label: COPY[locale].trip, state: "waiting", collapsed: true,
    tabs: COPY[locale].tripTabs.map((title, index) => ({ id: `t${index + 1}`, title, faviconSrc: icons[index] })) };
}

export function demoGroups(locale: AppLocale, { crashed = false }: { crashed?: boolean } = {}): TabStripGroup[] {
  const copy = COPY[locale];
  const groups: TabStripGroup[] = [
    { id: "mine", kind: "mine", tabs: [
      { id: "m1", title: copy.mine[0], faviconSrc: ICONS.docs }, { id: "m2", title: copy.mine[1], faviconSrc: ICONS.mail },
      { id: "m3", title: copy.mine[2], state: "loading" },
    ] },
    shoesGroup(locale),
    tripGroup(locale),
  ];
  if (crashed) groups.push({ id: "sync", kind: "conversation", label: copy.sync, state: "crashed", tabs: [{ id: "x1", title: copy.syncTab, state: "crashed" }] });
  return groups;
}

/** My tabs beside one conversation group; with `middle`, the conversation has four tabs. */
export function pairedGroups(locale: AppLocale, { middle = false }: { middle?: boolean } = {}): TabStripGroup[] {
  const mine = demoGroups(locale)[0]!;
  return [{ ...mine, tabs: mine.tabs.slice(0, 2) }, shoesGroup(locale, middle ? 4 : 2)];
}

/** One folded group beside an open one. */
export function foldedGroups(locale: AppLocale): TabStripGroup[] {
  return [shoesGroup(locale), tripGroup(locale)];
}

/** One conversation's own tabs, as its browser pane shows them. */
export function conversationGroup(locale: AppLocale): TabStripGroup[] {
  const copy = COPY[locale];
  return [shoesGroup(locale)];
}

/** Many tabs, to show shrink-to-fit and the sideways scroll with edge fades. */
export function crowdedGroups(locale: AppLocale): TabStripGroup[] {
  const copy = COPY[locale];
  const titles = [...copy.mine, ...copy.shop, ...copy.tripTabs, copy.syncTab];
  const tabs: TabStripTab[] = Array.from({ length: 14 }, (_, index) => ({
    id: `n${index}`, title: titles[index % titles.length]!, faviconSrc: Object.values(ICONS)[index % 4],
  }));
  return [{ id: "mine", kind: "mine", tabs: tabs.slice(0, 9) }, { id: "shoes", kind: "conversation", label: copy.shoes, state: "working", tabs: tabs.slice(9) }];
}

/** The App container in miniature: state lives outside the block, which only reports intents. */
export function TabStripDemo({ locale, initial, activeTabId = "m2", ...props }: {
  locale: AppLocale;
  initial: TabStripGroup[];
  activeTabId?: string;
} & Partial<Pick<TabStripProps, "panelId" | "hideChip" | "trailing">>) {
  const [groups, setGroups] = useState(initial);
  const [active, setActive] = useState<string | null>(activeTabId);
  const [created, setCreated] = useState(0);
  const close = (tabId: string) => {
    const order = groups.flatMap((group) => group.tabs.map((tab) => tab.id));
    const at = order.indexOf(tabId);
    if (tabId === active) setActive(order[at + 1] ?? order[at - 1] ?? null);
    setGroups((current) => current.map((group) => ({ ...group, tabs: group.tabs.filter((tab) => tab.id !== tabId) }))
      .filter((group) => group.kind === "mine" || group.tabs.length > 0));
  };
  // The row's + opens a tab in "my tabs", or in the only group shown (a conversation's own pane); a pill's + in its group.
  const newTab = (target = groups.find((group) => group.kind === "mine")?.id ?? groups[0]?.id) => {
    const id = `new-${created}`;
    setCreated(created + 1);
    setGroups((current) => current.map((group) => (group.id === target ? { ...group, tabs: [...group.tabs, { id, title: "" }] } : group)));
    setActive(id);
  };
  return (
    <TabStrip groups={groups} activeTabId={active} labels={demoLabels(locale)} onActivate={setActive} onClose={close} onNewTab={() => newTab()} onNewTabInGroup={newTab}
      onMove={(move) => setGroups((current) => applyTabStripMove(current, move))}
      onToggleGroup={(groupId, collapsed) => setGroups((current) => current.map((group) => (group.id === groupId ? { ...group, collapsed } : group)))}
      {...props} />
  );
}
