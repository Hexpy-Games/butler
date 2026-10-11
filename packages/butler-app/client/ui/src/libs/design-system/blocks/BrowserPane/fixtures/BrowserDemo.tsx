import { useLayoutEffect, useState, type ReactNode } from "react";
import { ButtonContainer } from "../../../components/ButtonContainer";
import { IconButton } from "../../../components/IconButton";
import { ArrowLeft, ArrowRight, Bookmark, MoreHorizontal, Pick, RefreshCcw, Scrap, TabIn } from "../../../components/Icons";
import { AddressField } from "../../AddressField";
import { AgentPointer } from "../../AgentPointer";
import { PageCard, type PageCardHolder } from "../../PageCard";
import { TabStrip } from "../../TabStrip";
import { demoLabels, ICONS } from "../../TabStrip/TabStrip.demo";
import { BrowserPane, BrowserToolbar } from "../BrowserPane";
import { BROWSER_DEMO_COPY } from "./copy";
import { DemoBand, type DemoBandKind } from "./DemoBand";
import { shopCardRect, shopPage } from "./pages";

type Locale = "en-US" | "ko-KR";
const AGENT_VIEWPORT = { width: 1280, height: 800 };
const PAGE_STYLE = { display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left" } as const;

export interface BrowserDemoProps {
  locale: Locale;
  placement?: "conversation" | "standalone";
  holder?: PageCardHolder;
  band?: DemoBandKind | null;
  /** Butler's pointer clicking the first product (agent tabs). */
  pointer?: boolean;
  /** Butler's fixed 1280×800 page (letterboxed); false: a page you browse at the card's size. */
  agent?: boolean;
  loading?: number;
  overlay?: ReactNode;
  /** Badge on the pick button (picked elements kept on the tab). */
  picks?: number;
}

/** The page area's layout size (not its on-screen rect: the viewer may scale the frame). */
function useLayoutSize(node: HTMLElement | null) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!node) return undefined;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return size;
}

/** The browser pane as the App composes it: tab row, toolbar, page card with band and pointer. */
export function BrowserDemo({
  locale, placement = "conversation", holder = "butler", band = "agent", pointer = true, agent = true, loading, overlay, picks,
}: BrowserDemoProps) {
  const copy = BROWSER_DEMO_COPY[locale];
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const size = useLayoutSize(content);
  const [bookmarked, setBookmarked] = useState(false);
  const groups = [{ id: "c", kind: "conversation" as const, label: copy.conversation, tabs: [
    { id: "t1", title: copy.tabTitle, faviconSrc: ICONS.shop, state: holder === "butler" ? "working" as const : undefined },
  ] }];
  const scale = size ? size.width / AGENT_VIEWPORT.width : 1;
  const card = shopCardRect(0);
  const target = { x: card.x * scale, y: card.y * scale, width: card.width * scale, height: card.height * scale };
  const pointerLayer = pointer && agent && size ? (
    <AgentPointer mode="click" at={{ x: target.x + target.width * 0.55, y: target.y + target.height * 0.45 }} target={target}
      from={{ x: 72 * scale, y: 470 * scale }} width={size.width} height={size.height}
      labels={locale === "ko-KR" ? { butler: "버틀러" } : undefined} />
  ) : null;
  return (
    <BrowserPane placement={placement} label={copy.browser}
      tabs={(
        <TabStrip groups={groups} activeTabId="t1" hideChip={placement === "conversation"} labels={demoLabels(locale)}
          onActivate={() => undefined} onClose={() => undefined} onNewTab={() => undefined}
          trailing={placement === "conversation" ? <IconButton label={copy.bringTab}><TabIn size="md" /></IconButton> : undefined} />
      )}
      toolbar={(
        <BrowserToolbar
          navigation={(
            <ButtonContainer size="icon-sm">
              <IconButton label={copy.back}><ArrowLeft size="md" /></IconButton>
              <IconButton label={copy.forward} disabled><ArrowRight size="md" /></IconButton>
              <IconButton label={copy.reload}><RefreshCcw size="md" /></IconButton>
            </ButtonContainer>
          )}
          address={<AddressField url={copy.url} onSubmit={() => undefined} bookmarked={bookmarked} onToggleBookmark={() => setBookmarked(!bookmarked)} />}
          actions={(
            <ButtonContainer size="icon-sm">
              <IconButton label={copy.pick} badge={picks} pressed={band === "pick"}><Pick size="md" /></IconButton>
              <IconButton label={copy.scrap}><Scrap size="md" /></IconButton>
              <IconButton label={copy.bookmarks}><Bookmark size="md" /></IconButton>
              <IconButton label={copy.more}><MoreHorizontal size="md" /></IconButton>
            </ButtonContainer>
          )} />
      )}>
      <PageCard holder={holder} band={band ? <DemoBand kind={band} copy={copy} /> : undefined} loading={loading} loadingLabel={copy.loading}
        viewport={agent ? AGENT_VIEWPORT : undefined} onBoundsChange={() => undefined} contentRef={setContent}
        overlay={<>{pointerLayer}{overlay}</>}>
        <img src={shopPage(locale)} alt="" draggable={false} style={PAGE_STYLE} />
      </PageCard>
    </BrowserPane>
  );
}
