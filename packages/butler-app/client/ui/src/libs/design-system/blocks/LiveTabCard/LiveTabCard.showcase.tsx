import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { LiveTabCard, type LiveTabCardVariant } from "./LiveTabCard";
import { LIVE_PAGES } from "./fixtures";
import { LiveTabFrame } from "./LiveTabFrame";
import { DEMO_STATES, demoCard, useDemoStream, type DemoState } from "./liveTabDemo";
import styles from "./LiveTabCard.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "LiveTabCard",
  category: "Browser",
  tags: ["browser", "tab", "live", "preview", "thumbnail", "rail", "screencast", "agent"],
  status: "beta",
};

const names = {
  "en-US": { busy: "Butler browsing", handoff: "Needs you (hand-off)", approval: "Waiting for approval", held: "You hold it", error: "Error", idle: "Idle", live: "Live frames (ImageBitmap)", first: "Before the first frame" },
  "ko-KR": { busy: "버틀러가 조작 중", handoff: "확인 필요 (넘겨받기)", approval: "승인 대기", held: "직접 조작 중", error: "오류", idle: "대기", live: "라이브 화면 (ImageBitmap)", first: "첫 화면 전" },
} as const;

type Locale = ShowcaseRenderContext["locale"];

function Cell({ locale, state, variant }: { locale: Locale; state: DemoState; variant: LiveTabCardVariant }) {
  return (
    <div className={styles[variant]}>
      <Stack gap="xs">
        <Typo.Caption tone="tertiary">{names[locale][state]}</Typo.Caption>
        <LiveTabCard {...demoCard(locale, state, { variant })} />
      </Stack>
    </div>
  );
}

function Matrix({ locale, variant }: { locale: Locale; variant: LiveTabCardVariant }) {
  return (
    <Stack align="row" gap="lg" wrap cross="start">
      {DEMO_STATES.map((state) => <Cell key={state} locale={locale} state={state} variant={variant} />)}
    </Stack>
  );
}

/** Frames arrive as ImageBitmaps (here two pages alternating twice a second) and swap without a crossfade. */
function LiveStream({ locale }: { locale: Locale }) {
  const frame = useDemoStream([LIVE_PAGES.booking, LIVE_PAGES.bookingApproval], 500);
  return (
    <Stack align="row" gap="lg" wrap cross="start">
      <div className={styles.full}><LiveTabCard {...demoCard(locale, "busy", { frame })} /></div>
      <div className={styles.compact}><LiveTabCard {...demoCard(locale, "busy", { frame, variant: "compact" })} /></div>
      <div className={styles.chip}><LiveTabCard {...demoCard(locale, "busy", { frame, variant: "chip" })} /></div>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Full card: every state", widths: ["430", "app", "wide"], render: ({ locale }) => <Matrix locale={locale} variant="full" /> },
  { name: "Compact thumbnail: every state", widths: ["375", "app", "wide"], render: ({ locale }) => <Matrix locale={locale} variant="compact" /> },
  { name: "Shelf chip: every state", widths: ["320", "375", "app"], render: ({ locale }) => <Matrix locale={locale} variant="chip" /> },
  { name: "Live frames from ImageBitmap", widths: ["430", "app"], render: ({ locale }) => <LiveStream locale={locale} /> },
  {
    name: "Before the first frame",
    widths: ["375", "app"],
    render: ({ locale }) => (
      <Stack align="row" gap="lg" wrap cross="start">
        <div className={styles.full}><LiveTabCard {...demoCard(locale, "busy", { frame: null })} /></div>
        <div className={styles.compact}><LiveTabFrame favicon={demoCard(locale, "idle").favicon} /></div>
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible"],
  variants: ["full", "compact", "chip"],
  render: ({ locale, variant }) => (
    <div className={styles[variant as LiveTabCardVariant]}>
      <LiveTabCard {...demoCard(locale, "handoff", { variant: variant as LiveTabCardVariant })} />
    </div>
  ),
};
