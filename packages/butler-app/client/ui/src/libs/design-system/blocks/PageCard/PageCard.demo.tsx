import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { AlertCircle, Plus, RefreshCcw } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { BROWSER_DEMO_COPY } from "../BrowserPane/fixtures/copy";
import { DemoBand, type DemoBandKind } from "../BrowserPane/fixtures/DemoBand";
import fixtures from "../BrowserPane/fixtures/fixtures.module.css";
import { shopPage } from "../BrowserPane/fixtures/pages";
import { EmptyLine } from "../EmptyLine";
import { PageCard, type PageCardBounds, type PageCardHolder } from "./PageCard";

type Locale = "en-US" | "ko-KR";
const PAGE_STYLE = { display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left" } as const;
const COPY = {
  "en-US": { empty: "Open a new tab", newTab: "New tab", crashed: "Tab stopped", reload: "Reload", waiting: "waiting for the first frame" },
  "ko-KR": { empty: "새 탭을 열어보세요", newTab: "새 탭", crashed: "탭이 중단됨", reload: "새로고침", waiting: "첫 프레임 대기 중" },
} as const;

export interface PageCardDemoProps {
  locale: Locale;
  holder?: PageCardHolder;
  band?: DemoBandKind;
  loading?: number;
  agent?: boolean;
  state?: "page" | "empty" | "crashed";
  height?: number;
  overlay?: ReactNode;
  readout?: boolean;
}

/** A page card with a stand-in page, inset in a pane-coloured stage like BrowserPane's. */
export function PageCardDemo({ locale, holder = "none", band, loading, agent = false, state = "page", height = 320, overlay, readout = false }: PageCardDemoProps) {
  const copy = COPY[locale];
  const [bounds, setBounds] = useState<PageCardBounds | null>(null);
  const hidden = state !== "page";
  const fallback = state === "empty"
    ? <Stack fill justify="center" cross="center"><EmptyLine message={copy.empty} action={<Button size="sm" variant="outline" iconStart={<Plus size="md" />} text={copy.newTab} />} /></Stack>
    : <Stack fill justify="center" cross="center"><EmptyLine icon={<AlertCircle size="md" />} message={copy.crashed} action={<Button size="sm" variant="outline" iconStart={<RefreshCcw size="md" />} text={copy.reload} />} /></Stack>;
  return (
    <Stack gap="xs">
      <div className={fixtures.stage} style={{ height }}>
        <PageCard holder={holder} band={band ? <DemoBand kind={band} copy={BROWSER_DEMO_COPY[locale]} /> : undefined} loading={loading}
          viewport={agent ? { width: 1280, height: 800 } : undefined} hidden={hidden} onBoundsChange={setBounds} overlay={overlay}>
          {hidden ? fallback : <img src={shopPage(locale)} alt="" draggable={false} style={PAGE_STYLE} />}
        </PageCard>
      </div>
      {readout ? (
        <Typo.Caption numeric="tabular" tone="secondary" data-test-class="page-card-readout">
          {bounds ? `x ${bounds.x} · y ${bounds.y} · ${bounds.width} × ${bounds.height} · radius ${bounds.radius} · scale ${bounds.scale}` : copy.waiting}
        </Typo.Caption>
      ) : null}
    </Stack>
  );
}
