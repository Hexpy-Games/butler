import type { CSSProperties } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { DoDont, Specimen } from "./Chapter";
import { px, useComputed } from "./measure";
import type { SampleLocale } from "./typeRoles";
import f from "./Foundations.module.css";

const KO_PARAGRAPH = "Butler는 설정 페이지의 섹션 머리글을 카드 바깥에 두고, 카드 안쪽 필드 간격을 하나의 리듬으로 맞춥니다.";
const EN_PARAGRAPH = "Butler keeps a settings section's header outside its card and spaces every field inside the card on one rhythm, so long pages scan as a column of calm, even blocks rather than a wall of controls.";

/** Korean: keep words whole, keep Hangul untracked, attach units and particles. */
export function KoreanRules() {
  return (
    <Stack gap="xl">
      <DoDont lang="ko"
        doCaption={'keep-all: lines break between words in every lang="ko" subtree'}
        dontCaption="break-all splits a word mid-syllable"
        doRender={<div className={f.narrowColumn}><Typo.Body>{KO_PARAGRAPH}</Typo.Body></div>}
        dontRender={<div className={f.narrowColumn} data-break="all"><Typo.Body>{KO_PARAGRAPH}</Typo.Body></div>} />
      <DoDont lang="ko"
        doCaption="Tracking 0 on every role; Hangul keeps its own spacing"
        dontCaption="Negative tracking makes syllables collide"
        doRender={<Typo.H2>한글 제목은 자간을 줄이지 않습니다</Typo.H2>}
        dontRender={<Typo.H2 as="div"><span className={f.tightTracking}>한글 제목은 자간을 줄이지 않습니다</span></Typo.H2>} />
      <DoDont lang="ko"
        doCaption="Latin, numbers and units share the stack; particles attach"
        dontCaption="Spaces before particles and units, forced Latin font"
        doRender={<Typo.Body>Butler가 PR 3개를 12분 만에 검토했어요.</Typo.Body>}
        dontRender={<Typo.Body><span className={f.foreignLatin}>Butler</span> 가 PR 3 개를 12 분 만에 검토 했어요.</Typo.Body>} />
    </Stack>
  );
}

/** Live characters per line, so the measure is a number, not a guess. */
function MeasuredParagraph({ leading, measure, text, lang }: { leading: string; measure: string; text: string; lang: SampleLocale }) {
  const [ref, stats] = useComputed<HTMLDivElement, { cpl: number; lines: number }>((element, style) => {
    const lineHeight = px(style.lineHeight) || 1;
    const lines = Math.max(1, Math.round(element.getBoundingClientRect().height / lineHeight));
    return { cpl: Math.round(text.length / lines), lines };
  });
  return (
    <Stack gap="xs" minWidth="0">
      <div className={f.measured} lang={lang} ref={ref} style={{ "--sample-leading": `var(${leading})`, "--sample-measure": measure } as CSSProperties}>{text}</div>
      <Typo.Caption tone="tertiary" numeric="tabular">{stats ? `≈ ${stats.cpl} characters per line · ${stats.lines} lines · ${leading}` : leading}</Typo.Caption>
    </Stack>
  );
}

export function MeasureAndLeading({ locale }: { locale: SampleLocale }) {
  const text = locale === "ko" ? `${KO_PARAGRAPH} 긴 글은 읽기 폭 안에서 줄 간격을 넉넉히 둡니다.` : EN_PARAGRAPH;
  const leadings = tokenCatalog.filter((token) => /^--line-height-/u.test(token.name));
  return (
    <Stack gap="xl">
      <DoDont
        doCaption="Reading width (--page-max-width-narrow) with --line-height-document"
        dontCaption="Full-bleed lines at --line-height-tight lose the next line"
        doRender={<MeasuredParagraph lang={locale} leading="--line-height-document" measure="var(--page-max-width-narrow)" text={text} />}
        dontRender={<MeasuredParagraph lang={locale} leading="--line-height-tight" measure="100%" text={`${text} ${text}`} />} />
      <div className={f.leadingGrid}>
        {leadings.map((token) => (
          <Specimen key={token.name} caption={`${token.name} · ${token.light}`}>
            <div className={f.leadingSample} lang={locale} style={{ "--sample-leading": `var(${token.name})` } as CSSProperties}>
              {locale === "ko" ? "줄 간격은 역할이 정합니다. 두 줄로 보여 줍니다." : "Leading is set by the role. Two lines show it."}
            </div>
          </Specimen>
        ))}
      </div>
    </Stack>
  );
}

const LONG = {
  en: "Desktop client polish for the project dashboard, settings screens and the conversation footer before the release",
  ko: "릴리스 전에 프로젝트 대시보드, 설정 화면과 대화 하단 정보를 다듬는 데스크톱 클라이언트 작업",
};
const PATH = "/Users/butler/projects/design-system/viewer/foundations/Foundations.module.css";

export function Truncation({ locale }: { locale: SampleLocale }) {
  return (
    <div className={f.truncGrid} lang={locale}>
      <Specimen caption="truncate · one line, ellipsis (rows, tabs, titles)">
        <Typo.Body truncate>{LONG[locale]}</Typo.Body>
      </Specimen>
      <Specimen caption="lineClamp={2} · previews and cards">
        <Typo.Body lineClamp={2}>{LONG[locale]}</Typo.Body>
      </Specimen>
      <Specimen caption="lineClamp={3} · descriptions">
        <Typo.Body lineClamp={3}>{`${LONG[locale]} ${LONG[locale]}`}</Typo.Body>
      </Specimen>
      <Specimen caption={'wrap="anywhere" · paths and URLs never overflow'}>
        <Typo.Code as="div" wrap="anywhere">{PATH}</Typo.Code>
      </Specimen>
    </div>
  );
}

const FIGURES = ["1,111.11", "8,808.00", "11.71", "10,480.90"];

export function Numerals({ locale }: { locale: SampleLocale }) {
  const times = [9, 10, 13, 23].map((hour) => new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(Date.UTC(2026, 8, 27, hour, 5 + hour)));
  return (
    <DoDont lang={locale}
      doCaption={'numeric="tabular" in columns, times and counters'}
      dontCaption="Proportional figures jitter down a column"
      doRender={(
        <div className={f.figureColumns}>
          <Stack gap="none">{FIGURES.map((figure) => <Typo.Body align="end" key={figure} numeric="tabular">{figure}</Typo.Body>)}</Stack>
          <Stack gap="none">{times.map((time) => <Typo.Body align="end" key={time} numeric="tabular">{time}</Typo.Body>)}</Stack>
        </div>
      )}
      dontRender={(
        <div className={`${f.figureColumns} ${f.proportional}`}>
          <Stack gap="none">{FIGURES.map((figure) => <Typo.Body align="end" key={figure}>{figure}</Typo.Body>)}</Stack>
          <Stack gap="none">{times.map((time) => <Typo.Body align="end" key={time}>{time}</Typo.Body>)}</Stack>
        </div>
      )} />
  );
}
