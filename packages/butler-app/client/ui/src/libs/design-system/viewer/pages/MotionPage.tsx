import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseRenderContext } from "../../showcase";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { tokenCatalog } from "../foundations/catalog";
import { PageHeader } from "../parts";
import { StoryCanvas } from "../StoryFrame";
import type { ViewerState } from "../viewerState";
import styles from "../DesignSystemViewer.module.css";

type AppLocale = ShowcaseRenderContext["locale"];

/** DS motion components, played through their own showcase stories (no copies). */
const COMPONENT_STORIES: Array<[string, string, string]> = [
  ["components/Presence", "Rise", "Presence: mount and unmount with an exit"],
  ["components/Collapsible", "Reveal", "Collapsible: height reveal with interpolate-size"],
  ["components/CopyButton", "Copy and confirm", "CopyButton: icon morph to a check"],
  ["components/AnimatedNumber", "Count to a new value", "AnimatedNumber: counts over --motion-deliberate"],
  ["components/Tabs", "Page navigation (line)", "Tabs: the line indicator slides"],
  ["components/Switch", "Sizes and values", "Switch: spring thumb"],
  ["components/DropdownMenu", "Session actions", "Overlays: menu scale and fade from the trigger"],
  ["components/Dialog", "Rename conversation", "Overlays: dialog and backdrop"],
  ["components/Tooltip", "Icon button label", "Overlays: tooltip presence"],
  ["blocks/QueuedMessage", "Send flight", "Send flight: the bubble flies from the composer"],
  ["components/Spinner", "Sizes and busy button", "Spinner: arc loop"],
  ["components/Toast", "Motion", "Toasts: drop in, stack, leave faster"],
];

function useReplay(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const [run, setRun] = useState(0);
  useEffect(() => {
    setOn(false);
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(frame);
  }, [run]);
  return [on, () => setRun((value) => value + 1)];
}

function Track({ name, duration, easing, on }: { name: string; duration: string; easing: string; on: boolean }) {
  const style = { "--motion-duration": duration, "--motion-easing": easing } as CSSProperties;
  return (
    <Stack gap="xs" data-ds-motion-token={name}>
      <Stack align="row" justify="between" gap="sm"><Typo.Code>{name}</Typo.Code>
        <Typo.Caption tone="tertiary">{tokenCatalog.find((token) => token.name === name)?.light ?? ""}</Typo.Caption></Stack>
      <div className={styles.motionTrack} data-on={on} style={style}><span className={styles.motionDot} /></div>
    </Stack>
  );
}

export function MotionPage({ entries, locale, state, onChange }: {
  entries: ShowcaseEntry[];
  locale: AppLocale;
  state: ViewerState;
  onChange: (patch: Partial<ViewerState>) => void;
  onOpen: (page: string) => void;
}) {
  const [durationsOn, replayDurations] = useReplay();
  const [easingsOn, replayEasings] = useReplay();
  const [shiftOn, replayShift] = useReplay();
  const group = (name: string) => tokenCatalog.filter((token) => token.category === "motion" && token.group === name);
  return (
    <Stack gap="2xl" data-ds-motion-page>
      <PageHeader eyebrow="Foundations · Motion" title="Linear-crisp motion"
        lead="Short, decelerating entrances; faster exits; no bounce except the Switch thumb and the drag lift. Motion lives in DS components and tokens; product code never declares transitions. Reduced motion keeps the fades and drops the travel.">
        <Stack align="row" cross="center" gap="sm" wrap>
          <SegmentedControl ariaLabel="Reduced motion" options={[{ value: "full", label: "Full motion" }, { value: "reduced", label: "Reduced motion" }]}
            value={state.motion} onValueChange={(motion) => onChange({ motion: motion as ViewerState["motion"] })} />
          <Typo.Caption tone="secondary">Reduced scopes the token overrides to this page (data-motion); the OS setting also switches CSS loops off.</Typo.Caption>
        </Stack>
      </PageHeader>
      <Section title="Durations" titleAs="h2" description="Each dot travels the same track with the standard easing; exits run about 0.7×."
        actions={<Button size="sm" variant="outline" text="Replay" data-ds-motion="durations" onClick={replayDurations} />}>
        <div className={styles.cardGrid}>
          {group("Durations").map((token) => <Track key={token.name} name={token.name} duration={`var(${token.name})`} easing="var(--motion-ease-standard)" on={durationsOn} />)}
        </div>
      </Section>
      <Section title="Easings" titleAs="h2" description="Played at three times --motion-deliberate so the curve is visible."
        actions={<Button size="sm" variant="outline" text="Replay" data-ds-motion="easings" onClick={replayEasings} />}>
        <div className={styles.cardGrid}>
          {group("Easings").map((token) => <Track key={token.name} name={token.name} duration="calc(var(--motion-deliberate) * 3)" easing={`var(${token.name})`} on={easingsOn} />)}
        </div>
      </Section>
      <Section title="Distances and scales" titleAs="h2" description="Travel and scale are tokens, so reduced motion zeroes them globally."
        actions={<Button size="sm" variant="outline" text="Replay" data-ds-motion="distances" onClick={replayShift} />}>
        <Stack align="row" gap="xl" wrap>
          {group("Distances and scales").map((token) => (
            <Stack gap="xs" cross="center" key={token.name} data-ds-motion-token={token.name}>
              <span className={styles.motionBox} data-on={shiftOn} style={{ [token.name.includes("distance") ? "--sample" : "--sample-scale"]: `var(${token.name})` } as CSSProperties} />
              <Typo.Code>{token.name}</Typo.Code>
            </Stack>
          ))}
        </Stack>
      </Section>
      <Section title="Loops" titleAs="h2" description="Spinner, pulse and shimmer loop on their own durations; reduced motion stops them.">
        <Stack align="row" cross="center" gap="xl" wrap>
          {group("Loops").map((token) => <Typo.Code key={token.name}>{`${token.name}: ${token.light}`}</Typo.Code>)}
          <Spinner size={24} label="Loading" />
        </Stack>
      </Section>
      <Section title="DS motion components" titleAs="h2" description="Live stories from each component's showcase, with their own replay controls.">
        <div className={styles.gallery}>
          {COMPONENT_STORIES.map(([id, storyName, title]) => {
            const story = entries.find((entry) => entry.id === id)?.stories.find((item) => item.name === storyName);
            return story ? (
              <div className={styles.card} data-ds-motion-component={id} key={`${id}#${storyName}`}>
                <Section title={title}><StoryCanvas story={story} locale={locale === "ko-KR" ? "ko" : "en"} /></Section>
              </div>
            ) : null;
          })}
        </div>
      </Section>
    </Stack>
  );
}

export const MOTION_COMPONENT_STORIES = COMPONENT_STORIES;
