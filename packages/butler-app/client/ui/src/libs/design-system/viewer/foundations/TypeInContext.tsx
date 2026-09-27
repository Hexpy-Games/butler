import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Switch } from "../../components/Switch";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { px } from "./measure";
import type { SampleLocale } from "./typeRoles";
import f from "./Foundations.module.css";

/** A numbered callout on one text element; the legend reads its applied style. */
function Anno({ n, role, children }: { n: number; role: string; children: ReactNode }) {
  return (
    <div className={f.anno} data-anno={n} data-anno-role={role}>
      <span className={f.annoMark} aria-hidden="true">{n}</span>
      <div className={f.annoBody}>{children}</div>
    </div>
  );
}

interface LegendRow { n: string; role: string; spec: string }

function Annotated({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [legend, setLegend] = useState<LegendRow[]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const read = () => setLegend([...root.querySelectorAll<HTMLElement>("[data-anno]")].map((anno) => {
      const text = anno.querySelector<HTMLElement>(`.${f.annoBody} > *`) ?? anno;
      const style = getComputedStyle(text);
      return { n: anno.dataset.anno ?? "", role: anno.dataset.annoRole ?? "", spec: `${px(style.fontSize)}/${px(style.lineHeight)} · ${style.fontWeight}` };
    }));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={f.context} data-ds-specimen={`context-${title}`}>
      <div className={f.contextStage} ref={ref}>{children}</div>
      <Stack gap="xs" minWidth="0">
        <Typo.SectionTitle tone="tertiary">{title}</Typo.SectionTitle>
        {legend.map((row) => (
          <div className={f.legendRow} key={row.n}>
            <span className={f.annoMark} aria-hidden="true">{row.n}</span>
            <Typo.Code>{row.role}</Typo.Code>
            <Typo.Caption tone="tertiary" numeric="tabular">{row.spec}</Typo.Caption>
          </div>
        ))}
      </Stack>
    </div>
  );
}

const COPY = {
  en: {
    section: "Appearance", sectionLead: "Applies to every window.", field: "Translucent sidebar", fieldHint: "Show the desktop behind the sidebar.",
    ask: "Can you summarize what changed in the release branch?", answer: "Three changes landed since Monday: the settings rhythm, the new focus ring and the Korean line breaking fix.",
    command: "git log --oneline main..release", meta: "1:25 PM · 2 files",
    dash: "This week", metric: "1,284", metricLabel: "Tasks completed", change: "+12%", pinned: "Pinned", row: "Design system review", open: "Open",
  },
  ko: {
    section: "화면 설정", sectionLead: "모든 창에 적용됩니다.", field: "반투명 사이드바", fieldHint: "사이드바 뒤로 바탕 화면을 비춥니다.",
    ask: "릴리스 브랜치에서 무엇이 바뀌었는지 요약해 줄래요?", answer: "월요일 이후 세 가지가 반영됐어요. 설정 간격, 새 포커스 링, 한국어 줄바꿈 수정입니다.",
    command: "git log --oneline main..release", meta: "오후 1:25 · 파일 2개",
    dash: "이번 주", metric: "1,284", metricLabel: "완료한 작업", change: "+12%", pinned: "고정됨", row: "디자인 시스템 검토", open: "열기",
  },
} as const;

/** Three Butler snippets, each text numbered with the role it is set in. */
export function TypeInContext({ locale }: { locale: SampleLocale }) {
  const copy = COPY[locale];
  return (
    <div className={f.contextGrid} key={locale} lang={locale}>
      <Annotated title="Settings section">
        <Stack gap="md">
          <Stack gap="xs">
            <Anno n={1} role="Typo.H4"><Typo.H4 as="h3">{copy.section}</Typo.H4></Anno>
            <Anno n={2} role="Typo.Body"><Typo.Body tone="secondary">{copy.sectionLead}</Typo.Body></Anno>
          </Stack>
          <div className={f.contextSurface}>
            <Stack align="row" cross="center" justify="between" gap="md">
              <Stack gap="xs" minWidth="0">
                <Anno n={3} role="Typo.Label"><Typo.Label as="div">{copy.field}</Typo.Label></Anno>
                <Anno n={4} role="Typo.Caption"><Typo.Caption as="div" tone="secondary">{copy.fieldHint}</Typo.Caption></Anno>
              </Stack>
              <Switch aria-label={copy.field} defaultChecked />
            </Stack>
          </div>
        </Stack>
      </Annotated>
      <Annotated title="Conversation turn">
        <Stack gap="md">
          <div className={f.contextBubble}>
            <Anno n={1} role="Typo.Body"><Typo.Body>{copy.ask}</Typo.Body></Anno>
          </div>
          <Anno n={2} role="Typo.Body"><Typo.Body>{copy.answer}</Typo.Body></Anno>
          <Anno n={3} role="Typo.Code"><Typo.Code as="div" wrap="anywhere">{copy.command}</Typo.Code></Anno>
          <Anno n={4} role="Typo.Caption"><Typo.Caption as="div" tone="tertiary" numeric="tabular">{copy.meta}</Typo.Caption></Anno>
        </Stack>
      </Annotated>
      <Annotated title="Dashboard card">
        <Stack gap="md">
          <Anno n={1} role="Typo.DashboardTitle"><Typo.DashboardTitle as="div">{copy.dash}</Typo.DashboardTitle></Anno>
          <div className={f.contextSurface}>
            <Stack gap="xs">
              <Stack align="row" cross="center" gap="sm">
                <Anno n={2} role="Typo.MetricValue"><Typo.MetricValue as="div" numeric="tabular">{copy.metric}</Typo.MetricValue></Anno>
                <Tag tone="success">{copy.change}</Tag>
              </Stack>
              <Anno n={3} role="Typo.Caption"><Typo.Caption as="div" tone="secondary">{copy.metricLabel}</Typo.Caption></Anno>
            </Stack>
          </div>
          <Anno n={4} role="Typo.SectionTitle"><Typo.SectionTitle as="div" tone="tertiary">{copy.pinned}</Typo.SectionTitle></Anno>
          <Stack align="row" cross="center" justify="between" gap="sm">
            <Anno n={5} role="Typo.PanelTitle"><Typo.PanelTitle as="div" truncate>{copy.row}</Typo.PanelTitle></Anno>
            <Button size="xs" variant="outline" text={copy.open} />
          </Stack>
        </Stack>
      </Annotated>
    </div>
  );
}
