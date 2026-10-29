import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { getAppCopy } from "../../../../../../../../butler-i18n/src/locale.ts";
import { IconButton } from "../../components/IconButton";
import { Globe2, MoreHorizontal, PanelRight } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ActivityGlow, activityGlowTone, type ActivityGlowState } from "./ActivityGlow";

export const meta: ShowcaseMeta = {
  title: "ActivityGlow",
  category: "Browser",
  tags: ["browser", "toggle", "titlebar", "glow", "halo", "status", "background", "busy", "attention"],
  status: "beta",
};

const STATES: readonly ActivityGlowState[] = ["idle", "busy", "attention", "error"];

const names = {
  "en-US": { idle: "Idle", busy: "Butler browsing", attention: "Needs you", error: "Error", open: "Browser open" },
  "ko-KR": { idle: "대기", busy: "버틀러가 사용 중", attention: "확인 필요", error: "오류", open: "브라우저 열림" },
} as const;

/** The toggle's label as the App builds it: the base action plus the state's suffix (butler-i18n browser.glow). */
function toggleLabel(locale: ShowcaseRenderContext["locale"], state: ActivityGlowState, open = false): string {
  const copy = getAppCopy(locale).browser;
  if (open) return copy.hide;
  return state === "idle" ? copy.show : copy.glow[state];
}

function Toggle({ locale, state, open = false, reducedMotion }: { locale: ShowcaseRenderContext["locale"]; state: ActivityGlowState; open?: boolean; reducedMotion?: boolean }) {
  return (
    <ActivityGlow state={open ? "idle" : state} reducedMotion={reducedMotion}>
      <IconButton label={toggleLabel(locale, state, open)} tone={activityGlowTone(state, open)} pane="browser" pressed={open}>
        <Globe2 size="md" />
      </IconButton>
    </ActivityGlow>
  );
}

function Row({ locale, reducedMotion }: ShowcaseRenderContext & { reducedMotion?: boolean }) {
  const text = names[locale];
  return (
    <Stack align="row" gap="xl" wrap>
      {STATES.map((state) => (
        <Stack key={state} gap="xs" cross="center">
          <Toggle locale={locale} state={state} reducedMotion={reducedMotion} />
          <Typo.Caption tone="secondary">{text[state]}</Typo.Caption>
        </Stack>
      ))}
      <Stack gap="xs" cross="center">
        <Toggle locale={locale} state="busy" open reducedMotion={reducedMotion} />
        <Typo.Caption tone="secondary">{text.open}</Typo.Caption>
      </Stack>
    </Stack>
  );
}

/** The titlebar's trailing icons as the conversation shows them, with the toggle in the middle. */
function Trailing({ locale, state }: ShowcaseRenderContext & { state: ActivityGlowState }) {
  const copy = getAppCopy(locale).browser;
  return (
    <Stack align="row" gap="sm" cross="center">
      <IconButton label={copy.more}><MoreHorizontal size="md" /></IconButton>
      <Toggle locale={locale} state={state} />
      <IconButton label={copy.title}><PanelRight size="md" /></IconButton>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Every state", widths: ["375", "app"], render: (context) => <Row {...context} /> },
  { name: "Reduced motion: dots only", widths: ["375", "app"], render: (context) => <Row {...context} reducedMotion /> },
  { name: "Titlebar: Butler browsing", widths: ["320", "app"], render: (context) => <Trailing {...context} state="busy" /> },
  { name: "Titlebar: needs you", widths: ["320", "app"], render: (context) => <Trailing {...context} state="attention" /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible"],
  variants: [...STATES],
  render: ({ locale, variant }) => <Toggle locale={locale} state={variant as ActivityGlowState} />,
};
