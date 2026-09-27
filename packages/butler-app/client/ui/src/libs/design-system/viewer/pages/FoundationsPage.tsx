import type { CSSProperties, ReactNode } from "react";
import { Card } from "../../components/Card";
import { Sparkles } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { tokenCatalog, tokenDefinitions } from "../foundations/catalog";
import { chapterPage, chapterTokens, FOUNDATION_CHAPTERS, type FoundationChapterId } from "../foundations/chapters";
import styles from "../DesignSystemViewer.module.css";
import f from "../foundations/Foundations.module.css";

const v = (name: string, value: string) => ({ [name]: `var(${value})` }) as CSSProperties;

/** A thumbnail specimen per chapter, drawn from the chapter's own tokens. */
const MINI: Record<FoundationChapterId, () => ReactNode> = {
  color: () => (
    <span className={f.miniSwatches}>
      {["--grayscale-12", "--grayscale-07", "--grayscale-03", "--accent", "--color-success", "--color-warning", "--color-danger"]
        .map((name) => <span key={name} style={v("--swatch", name)} />)}
    </span>
  ),
  typography: () => <span className={f.miniType}>Aa<span lang="ko">가</span></span>,
  spacing: () => <span className={f.miniStair}>{["xs", "sm", "md", "lg", "xl", "2xl"].map((step) => <span key={step} style={v("--step", `--space-${step}`)} />)}</span>,
  sizing: () => <span className={f.miniBars}>{["xs", "sm", "md", "lg"].map((step) => <span key={step} style={v("--step", `--control-height-${step}`)} />)}</span>,
  radius: () => <span className={f.miniShapes}>{["control", "panel", "popover", "composer"].map((step) => <span key={step} style={v("--step", `--radius-${step}`)} />)}</span>,
  iconography: () => <span className={f.miniIcons}><Sparkles size="sm" /><Sparkles size="md" /><Sparkles size="lg" /><Sparkles size="xl" /></span>,
  focus: () => <span className={f.miniFocus} />,
  motion: () => <span className={f.miniMotion}><span /></span>,
  "z-index": () => <span className={f.miniLayers}><span /><span /><span /></span>,
  layout: () => <span className={f.miniSafe}><span /></span>,
};

export function FoundationsPage({ onOpen }: { onOpen: (page: string) => void }) {
  const legacy = tokenCatalog.filter((token) => token.legacy).length;
  return (
    <Stack gap="2xl" data-ds-foundations="index">
      <header className={f.chapterHead}>
        <div className={f.chapterKicker}><Tag tone="accent" size="md">Foundations</Tag></div>
        <h1 className={f.chapterTitle}>The Butler guidebook</h1>
        <p className={styles.lead}>
          Ten chapters on how Butler looks and feels: color, type, space, shape, motion. Every specimen is drawn from tokens.css, so the page is the spec.
        </p>
        <Stack align="row" cross="center" gap="sm" wrap>
          <Tag>{`${tokenCatalog.length} tokens`}</Tag>
          <Tag>{`${tokenDefinitions.length} definitions`}</Tag>
          <Typo.Caption tone="tertiary">{`${legacy} legacy aliases marked with their replacement`}</Typo.Caption>
        </Stack>
      </header>
      <div className={f.chapterGrid}>
        {FOUNDATION_CHAPTERS.map((chapter) => (
          <Card interactive key={chapter.id} aria-label={chapter.title} onClick={() => onOpen(chapterPage(chapter))} data-ds-token-category={chapter.id}>
            <div className={f.chapterCard}>
              <div className={f.miniStage} aria-hidden="true">{MINI[chapter.id]()}</div>
              <Stack align="row" cross="baseline" gap="sm">
                <span className={f.cardNumber}>{chapter.number}</span>
                <Typo.PanelTitle>{chapter.title}</Typo.PanelTitle>
              </Stack>
              <Typo.Caption tone="secondary">{chapter.summary}</Typo.Caption>
              <Typo.Caption tone="tertiary" numeric="tabular">{`${chapterTokens(tokenCatalog, chapter).length} tokens`}</Typo.Caption>
            </div>
          </Card>
        ))}
      </div>
    </Stack>
  );
}
