import { useState, type CSSProperties } from "react";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { tokenCatalog } from "../foundations/catalog";
import { ChapterLayout, chapterSections, GuideSection } from "../foundations/Chapter";
import { chapterById } from "../foundations/chapters";
import { StoryCanvas } from "../StoryFrame";
import type { ViewerState } from "../viewerState";
import styles from "../DesignSystemViewer.module.css";

type AppLocale = ShowcaseRenderContext["locale"];

/** DS motion components, played through their own showcase stories (no copies). */
const COMPONENT_STORIES: Array<[string, string, string]> = [
  ["components/Presence", "Rise", "Presence: mount and unmount with an exit"],
  ["components/Collapsible", "Reveal", "Collapsible: height reveal with interpolate-size"],
  ["components/CopyButton", "Copy and confirm", "CopyButton: icon morph to a drawn check"],
  ["components/AnimatedNumber", "Count to a new value", "AnimatedNumber: counts over --motion-deliberate"],
  ["components/Tabs", "Page navigation (line)", "Tabs: the line indicator slides"],
  ["components/Switch", "Sizes and values", "Switch: spring thumb"],
  ["components/DropdownMenu", "Session actions", "Overlays: menu scale and fade from the trigger"],
  ["components/Dialog", "Rename conversation", "Overlays: dialog and backdrop"],
  ["components/Tooltip", "Icon button label", "Overlays: tooltip presence"],
  ["blocks/QueuedMessage", "Send flight", "Send flight: the bubble flies from the composer"],
  ["components/Spinner", "Sizes and busy button", "Spinner: arc loop"],
  ["components/LoadingIndicator", "Spinner to check", "LoadingIndicator: spinner resolves into a drawn check"],
  ["components/ButlerThinkingMark", "Idle to working", "ButlerThinkingMark: halftone morph and settle to the logo"],
  ["components/Toast", "Motion", "Toasts: drop in, stack, leave faster"],
];

/**
 * Replay by remount: bumping `run` changes the demos' keys, so the browser
 * mounts new nodes and their CSS animations start again from the first frame.
 * (Flipping an attribute off and on reverses a running transition instead.)
 */
function useReplay(): [number, () => void] {
  const [run, setRun] = useState(0);
  return [run, () => setRun((value) => value + 1)];
}

function Track({ name, duration, easing, run }: { name: string; duration: string; easing: string; run: number }) {
  const style = { "--motion-duration": duration, "--motion-easing": easing } as CSSProperties;
  return (
    <Stack gap="xs" data-ds-motion-token={name}>
      <Stack align="row" justify="between" gap="sm"><Typo.Code>{name}</Typo.Code>
        <Typo.Caption tone="tertiary">{tokenCatalog.find((token) => token.name === name)?.light ?? ""}</Typo.Caption></Stack>
      <div className={styles.motionTrack} data-ds-motion-demo data-ds-motion-run={run} key={run} style={style}><span className={styles.motionDot} /></div>
    </Stack>
  );
}

/** A component story card with its own Replay: remounting the story restarts its enter motion. */
function ComponentStoryCard({ id, title, story, locale }: { id: string; title: string; story: ShowcaseStory; locale: AppLocale }) {
  const [run, replay] = useReplay();
  return (
    <div className={styles.card} data-ds-motion-component={id}>
      <Section title={title} actions={<Button size="xs" variant="borderless" text="Replay" data-ds-motion="story" onClick={replay} />}>
        <div data-ds-motion-demo data-ds-motion-run={run} key={run}>
          <StoryCanvas story={story} locale={locale === "ko-KR" ? "ko" : "en"} />
        </div>
      </Section>
    </div>
  );
}

export function MotionPage({ entries, locale, state, anchor, onChange, onOpen }: {
  entries: ShowcaseEntry[];
  anchor?: string;
  locale: AppLocale;
  state: ViewerState;
  onChange: (patch: Partial<ViewerState>) => void;
  onOpen: (page: string) => void;
}) {
  const [durationsRun, replayDurations] = useReplay();
  const [easingsRun, replayEasings] = useReplay();
  const [shiftRun, replayShift] = useReplay();
  const group = (name: string) => tokenCatalog.filter((token) => token.category === "motion" && token.group === name);
  const chapter = chapterById("motion")!;
  const s = chapterSections(chapter, [["durations", "Durations"], ["easings", "Easings"], ["distances", "Distances and scales"], ["loops", "Loops"], ["components", "DS motion components"]]);
  return (
    <div data-ds-motion-page>
      <ChapterLayout anchor={anchor} chapter={chapter} locale={locale === "ko-KR" ? "ko" : "en"} onOpen={onOpen} sections={s.list}
        lead="Short, decelerating entrances; faster exits; no bounce except the Switch thumb and the drag lift. Motion lives in DS components and tokens; product code never declares transitions. Reduced motion keeps the fades and drops the travel."
        headerExtra={(
          <SegmentedControl ariaLabel="Reduced motion" size="sm" options={[{ value: "full", label: "Full motion" }, { value: "reduced", label: "Reduced motion" }]}
            value={state.motion} onValueChange={(motion) => onChange({ motion: motion as ViewerState["motion"] })} />
        )}>
        <GuideSection spec={s.at("durations")} lead="Each dot travels the same track with the standard easing; exits run about 0.7×."
          actions={<Button size="sm" variant="outline" text="Replay" data-ds-motion="durations" onClick={replayDurations} />}>
          <div className={styles.cardGrid} data-ds-motion-group="durations">
            {group("Durations").map((token) => <Track key={token.name} name={token.name} duration={`var(${token.name})`} easing="var(--motion-ease-standard)" run={durationsRun} />)}
          </div>
        </GuideSection>
        <GuideSection spec={s.at("easings")} lead="Played at three times --motion-deliberate so the curve is visible."
          actions={<Button size="sm" variant="outline" text="Replay" data-ds-motion="easings" onClick={replayEasings} />}>
          <div className={styles.cardGrid} data-ds-motion-group="easings">
            {group("Easings").map((token) => <Track key={token.name} name={token.name} duration="calc(var(--motion-deliberate) * 3)" easing={`var(${token.name})`} run={easingsRun} />)}
          </div>
        </GuideSection>
        <GuideSection spec={s.at("distances")} lead="Travel and scale are tokens, so reduced motion zeroes them globally."
          actions={<Button size="sm" variant="outline" text="Replay" data-ds-motion="distances" onClick={replayShift} />}>
          <Stack align="row" gap="xl" wrap data-ds-motion-group="distances">
            {group("Distances and scales").map((token) => (
              <Stack gap="xs" cross="center" key={token.name} data-ds-motion-token={token.name}>
                <span className={styles.motionBox} data-ds-motion-demo data-ds-motion-run={shiftRun} key={shiftRun} style={{ [token.name.includes("distance") ? "--sample" : "--sample-scale"]: `var(${token.name})` } as CSSProperties} />
                <Typo.Code>{token.name}</Typo.Code>
              </Stack>
            ))}
          </Stack>
        </GuideSection>
        <GuideSection spec={s.at("loops")} lead="Spinner, pulse and shimmer loop on their own durations; reduced motion stops them.">
          <Stack align="row" cross="center" gap="xl" wrap>
            {group("Loops").map((token) => <Typo.Code key={token.name}>{`${token.name}: ${token.light}`}</Typo.Code>)}
            <Spinner size={24} label="Loading" />
          </Stack>
        </GuideSection>
        <GuideSection spec={s.at("components")} lead="Live stories from each component's showcase, with their own replay controls.">
          <div className={styles.gallery}>
            {COMPONENT_STORIES.map(([id, storyName, title]) => {
              const story = entries.find((entry) => entry.id === id)?.stories.find((item) => item.name === storyName);
              return story ? (
                <ComponentStoryCard key={`${id}#${storyName}`} id={id} title={title} story={story} locale={locale} />
              ) : null;
            })}
          </div>
        </GuideSection>
      </ChapterLayout>
    </div>
  );
}

export const MOTION_COMPONENT_STORIES = COMPONENT_STORIES;
