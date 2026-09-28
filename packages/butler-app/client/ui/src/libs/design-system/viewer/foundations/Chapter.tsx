import { useEffect, useState, type ReactNode } from "react";
import { NavRow } from "../../blocks/NavRow";
import { Button } from "../../components/Button";
import { Collapsible } from "../../components/Collapsible";
import { FoundationHeroMotion } from "../../components/FoundationHeroMotion";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { chapterPage, chapterTokens, FOUNDATION_CHAPTERS, type FoundationChapter } from "./chapters";
import { tokensByCategory } from "./tokenCatalog";
import { TokenRow } from "./TokenRow";
import type { SampleLocale } from "./typeRoles";
import styles from "../DesignSystemViewer.module.css";
import f from "./Foundations.module.css";

export interface SectionSpec { id: string; number: string; title: string }

/** Numbered section specs for a chapter: 02.1, 02.2 … and the closing "All tokens". */
export function chapterSections(chapter: FoundationChapter, sections: Array<[string, string]>) {
  const list: SectionSpec[] = [...sections, ["all-tokens", "All tokens"] as [string, string]]
    .map(([id, title], index) => ({ id, title, number: `${chapter.number}.${index + 1}` }));
  return { list, at: (id: string): SectionSpec => list.find((spec) => spec.id === id) ?? list[0]! };
}

/** Chapters whose hero is the centrepiece: full width under the title instead of a panel beside it. */
const FEATURE_HEROES = new Set<string>(["typography"]);

export function ChapterHeader({ chapter, lead, onOpen, locale, children }: {
  chapter: FoundationChapter;
  lead: ReactNode;
  onOpen: (page: string) => void;
  /** Sample-copy language of the hero (its type specimen sets real lines). */
  locale?: SampleLocale;
  children?: ReactNode;
}) {
  const count = chapterTokens(tokenCatalog, chapter).length;
  const feature = FEATURE_HEROES.has(chapter.id) ? "" : undefined;
  return (
    <header className={f.chapterHead} data-ds-chapter-head={chapter.id} data-feature={feature}>
      <div className={f.chapterHeadGrid}>
        <div className={f.chapterHeadText}>
          <div className={f.chapterKicker}>
            <span className={f.chapterNumber} aria-hidden="true">{chapter.number}</span>
            <Button size="xs" variant="borderless" text="Foundations" onClick={() => onOpen("foundations")} />
          </div>
          <h1 className={f.chapterTitle}>{chapter.title}</h1>
          <p className={styles.lead}>{lead}</p>
          <Stack align="row" cross="center" gap="sm" wrap>
            <Tag>{`${count} tokens`}</Tag>
            <Typo.Caption tone="tertiary">Generated from tokens.css · light and dark</Typo.Caption>
            {children}
          </Stack>
        </div>
        <div className={f.chapterHero} data-ds-chapter-hero={chapter.id} data-feature={feature}>
          <FoundationHeroMotion variant={chapter.id} lang={locale} />
        </div>
      </div>
    </header>
  );
}

/** A numbered, anchored chapter section: number, title, one-line lead, specimen. */
export function GuideSection({ spec, lead, actions, children, ...props }: {
  spec: SectionSpec; lead?: ReactNode; actions?: ReactNode; children: ReactNode; [data: `data-${string}`]: string | undefined;
}) {
  return (
    <section className={f.guideSection} id={spec.id} aria-labelledby={`${spec.id}-title`} data-ds-guide-section={spec.id} {...props}>
      <div className={f.guideHead}>
        <span className={f.guideNumber}>{spec.number}</span>
        <Stack align="row" cross="center" justify="between" gap="md" wrap>
          <Typo.H2 id={`${spec.id}-title`}>{spec.title}</Typo.H2>
          {actions}
        </Stack>
        {lead ? <Typo.Body tone="secondary" wrap="normal">{lead}</Typo.Body> : null}
      </div>
      {children}
    </section>
  );
}

function ChapterToc({ sections, pageId, onOpen }: { sections: SectionSpec[]; pageId: string; onOpen: (page: string) => void }) {
  return (
    <nav aria-label="On this page" className={f.toc} data-ds-chapter-toc>
      <Stack gap="xs">
        <Typo.SectionTitle>On this page</Typo.SectionTitle>
        {sections.map((spec) => (
          <NavRow density="compact" key={spec.id} label={`${spec.number.split(".")[1]}  ${spec.title}`} onClick={() => onOpen(`${pageId}#${spec.id}`)} />
        ))}
      </Stack>
    </nav>
  );
}

/** Previous and next chapter, like the foot of a printed guide. */
function ChapterPager({ chapter, onOpen }: { chapter: FoundationChapter; onOpen: (page: string) => void }) {
  const index = FOUNDATION_CHAPTERS.findIndex((item) => item.id === chapter.id);
  const previous = FOUNDATION_CHAPTERS[index - 1];
  const next = FOUNDATION_CHAPTERS[index + 1];
  return (
    <div className={f.pager}>
      {previous ? <Button variant="outline" text={`← ${previous.number} ${previous.title}`} onClick={() => onOpen(chapterPage(previous))} /> : <span />}
      {next ? <Button variant="outline" text={`${next.number} ${next.title} →`} onClick={() => onOpen(chapterPage(next))} /> : null}
    </div>
  );
}

/** The raw token table, secondary: collapsed unless a token anchor asks for it. */
export function AllTokens({ chapter, spec, anchor }: { chapter: FoundationChapter; spec: SectionSpec; anchor?: string }) {
  const tokens = chapterTokens(tokenCatalog, chapter);
  const wanted = Boolean(anchor?.startsWith("token--") && tokens.some((token) => `token${token.name}` === anchor));
  const [open, setOpen] = useState(wanted);
  useEffect(() => {
    if (!wanted) return undefined;
    setOpen(true);
    const frame = requestAnimationFrame(() => document.getElementById(anchor!)?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [wanted, anchor]);
  const groups = chapter.categories.flatMap((category) => tokensByCategory(tokens, category));
  return (
    <GuideSection spec={spec} lead="Every token of this chapter with its light and dark value, computed live, each var() one click to copy.">
      <Stack align="row" cross="center" gap="sm" wrap>
        <Button variant="outline" size="sm" aria-expanded={open} aria-controls={`${chapter.id}-token-table`}
          text={open ? "Hide token table" : `Show ${tokens.length} tokens`} onClick={() => setOpen((value) => !value)} data-ds-all-tokens-toggle />
        <Typo.Caption tone="tertiary">{`${groups.length} ${groups.length === 1 ? "group" : "groups"}`}</Typo.Caption>
      </Stack>
      <Collapsible open={open} id={`${chapter.id}-token-table`}>
        <Stack gap="xl" data-ds-all-tokens={chapter.id}>
          {groups.map((group) => (
            <Stack gap="sm" key={group.group} data-ds-token-group={group.group}>
              <Typo.SectionTitle tone="secondary">{`${group.group} · ${group.tokens.length}`}</Typo.SectionTitle>
              <div className={styles.tokenTable}>{group.tokens.map((token) => <TokenRow key={token.name} token={token} />)}</div>
            </Stack>
          ))}
        </Stack>
      </Collapsible>
    </GuideSection>
  );
}

/** Chapter shell: header, numbered sections, sticky mini-TOC, token table and pager. */
export function ChapterLayout({ chapter, sections, lead, anchor, onOpen, locale, headerExtra, children }: {
  chapter: FoundationChapter;
  sections: SectionSpec[];
  lead: ReactNode;
  anchor?: string;
  locale?: SampleLocale;
  onOpen: (page: string) => void;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  const pageId = chapterPage(chapter);
  return (
    <div className={f.chapter} data-ds-foundations={chapter.id}>
      <ChapterHeader chapter={chapter} lead={lead} locale={locale} onOpen={onOpen}>{headerExtra}</ChapterHeader>
      <div className={f.jump} aria-label="Jump to section" role="navigation">
        {sections.map((spec) => <Button key={spec.id} size="xs" variant="outline" text={`${spec.number} ${spec.title}`} onClick={() => onOpen(`${pageId}#${spec.id}`)} />)}
      </div>
      <div className={f.chapterBody}>
        <div className={f.chapterMain}>
          {children}
          <AllTokens anchor={anchor} chapter={chapter} spec={sections.at(-1)!} />
          <ChapterPager chapter={chapter} onOpen={onOpen} />
        </div>
        <ChapterToc onOpen={onOpen} pageId={pageId} sections={sections} />
      </div>
    </div>
  );
}

/** A light pane and a dark pane, each a theme scope with its own text color. */
export function ThemePanes({ children, label }: { children: (theme: "light" | "dark") => ReactNode; label?: string }) {
  return (
    <div className={f.themePanes} aria-label={label}>
      {(["light", "dark"] as const).map((theme) => (
        <div className={`${f.themePane} theme-${theme}`} data-ds-theme={theme} key={theme}>
          <span className={f.themeLabel}>{theme === "light" ? "Light" : "Dark"}</span>
          {children(theme)}
        </div>
      ))}
    </div>
  );
}

/** A captioned specimen frame; the overflow smoke checks nothing paints past it. */
export function Specimen({ caption, children, tone = "plain", id }: { caption?: ReactNode; children: ReactNode; tone?: "plain" | "sunken"; id?: string }) {
  return (
    <figure className={f.specimen} data-tone={tone} data-ds-specimen={id ?? ""}>
      <div className={f.specimenBody}>{children}</div>
      {caption ? <figcaption className={f.specimenCaption}><Typo.Caption tone="secondary">{caption}</Typo.Caption></figcaption> : null}
    </figure>
  );
}

/** Do / don't pair in the viewer's verdict frames. */
export function DoDont({ doCaption, dontCaption, doRender, dontRender, lang }: {
  doCaption: string; dontCaption: string; doRender: ReactNode; dontRender: ReactNode; lang?: string;
}) {
  return (
    <div className={f.doDont} data-ds-do-dont>
      {([["do", "Do", doCaption, doRender], ["dont", "Don't", dontCaption, dontRender]] as const).map(([verdict, label, caption, render]) => (
        <div className={f.verdict} data-verdict={verdict} key={verdict}>
          <div className={f.verdictBody} lang={lang}>{render}</div>
          <Stack gap="none">
            <Typo.Label as="span" tone={verdict === "do" ? "success" : "danger"}>{label}</Typo.Label>
            <Typo.Caption tone="secondary">{caption}</Typo.Caption>
          </Stack>
        </div>
      ))}
    </div>
  );
}
