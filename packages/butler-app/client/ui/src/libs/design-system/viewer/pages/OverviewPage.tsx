import { useEffect, useState, type ReactNode } from "react";
import { MetricCard } from "../../blocks/MetricCard";
import { MetricGrid } from "../../blocks/MetricGrid";
import { Notice } from "../../blocks/Notice";
import { PromptFluidBackground } from "../../blocks/PromptSuggestionList";
import type { SidebarDensity } from "../../blocks/SidebarShell";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import {
  Activity, Blocks, BookOpenText, ImageIcon, LayoutDashboard, MagicWand, Palette, Sparkles,
} from "../../components/Icons";
import { Kbd } from "../../components/Kbd";
import { Section } from "../../components/Section";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { tokenCatalog } from "../foundations/catalog";
import { AssembledScreen, type AssembleStage } from "../overview/AssembledScreen";
import { OverviewPrinciples } from "../overview/OverviewPrinciples";
import { CodeSample } from "../parts";
import { PATTERNS } from "../patterns";
import { RECIPES } from "../recipes";
import type { ResolvedTheme } from "../useViewerTheme";
import type { ViewerState } from "../viewerState";
import styles from "../DesignSystemViewer.module.css";

const STAGES: AssembleStage[] = ["screen", "tokens", "components", "blocks"];

/** Plays the x-ray once (tokens → components → blocks → screen) until someone takes over. */
function useAssemble(): [AssembleStage, (stage: AssembleStage) => void, number, () => void] {
  const [stage, setStage] = useState<AssembleStage>("screen");
  const [auto, setAuto] = useState(true);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (!auto) return undefined;
    const order: AssembleStage[] = ["tokens", "components", "blocks", "screen"];
    const timers = order.map((next, index) => window.setTimeout(() => setStage(next), 1800 + index * 1600));
    const stop = window.setTimeout(() => setAuto(false), 1800 + order.length * 1600);
    return () => { timers.forEach((timer) => window.clearTimeout(timer)); window.clearTimeout(stop); };
  }, [auto, run]);
  return [stage, (next) => { setAuto(false); setStage(next); }, run, () => { setStage("screen"); setRun((value) => value + 1); setAuto(true); }];
}

function StartCard({ icon, title, body, onClick, count }: { icon: ReactNode; title: string; body: string; onClick: () => void; count?: string }) {
  return (
    <Card interactive aria-label={title} onClick={onClick}>
      <Stack gap="sm">
        <Stack align="row" cross="center" justify="between" gap="sm">{icon}{count ? <Tag>{count}</Tag> : null}</Stack>
        <Typo.PanelTitle>{title}</Typo.PanelTitle>
        <Typo.Caption tone="secondary">{body}</Typo.Caption>
      </Stack>
    </Card>
  );
}

export function OverviewPage({ entries, state, themes, onOpen, onChange }: {
  entries: ShowcaseEntry[];
  state: ViewerState;
  themes: ResolvedTheme[];
  onOpen: (page: string) => void;
  onChange: (patch: Partial<ViewerState>) => void;
}) {
  const [stage, setStage, run, replay] = useAssemble();
  const [density, setDensity] = useState<SidebarDensity>("comfortable");
  const [counted, setCounted] = useState(false);
  useEffect(() => { const frame = requestAnimationFrame(() => setCounted(true)); return () => cancelAnimationFrame(frame); }, []);
  const components = entries.filter((entry) => entry.kind === "component").length;
  const blocks = entries.length - components;
  const stories = entries.reduce((total, entry) => total + entry.stories.length, 0);
  const matrices = entries.filter((entry) => entry.stateMatrix).length;
  const guided = entries.filter((entry) => entry.guidance).length;
  const readmes = entries.filter((entry) => entry.readme).length;
  const value = (count: number) => (counted ? count : 0);
  const context = { locale: state.locale === "ko" ? "ko-KR" : "en-US" } as const;
  return (
    <Stack gap="2xl" data-ds-overview>
      <section className={styles.hero} data-ds-hero>
        {/* No tone: the hero sits in the chrome theme, which side-by-side frames[0] is not. */}
        <div className={styles.heroFluid}><PromptFluidBackground /></div>
        <div className={styles.heroGrid}>
          <Stack gap="lg">
            <Stack align="row"><Tag tone="accent" size="md">Butler Design System</Tag></Stack>
            <h1 className={styles.heroTitle}>One system. Every Butler screen.</h1>
            <p className={styles.lead}>
              Tokens, components and blocks that already run the app. Pick the piece, read how it is meant to be used, and assemble screens without new CSS.
            </p>
            <Stack align="row" cross="center" gap="sm" wrap>
              <Button text="Browse components" onClick={() => onOpen("components")} />
              <Button variant="outline" text="Build a screen" onClick={() => onOpen("recipes")} />
              <Stack align="row" cross="center" gap="xs"><Kbd keys={["⌘", "K"]} label="Command K" /><Typo.Caption tone="secondary">search anything</Typo.Caption></Stack>
            </Stack>
          </Stack>
          <TintedGlass radius="composer" padding="sm">
            <AssembledScreen context={context} density={density} run={run} stage={stage} />
          </TintedGlass>
        </div>
        <div className={styles.heroControls}>
          <SegmentedControl ariaLabel="X-ray layer" size="sm" value={stage} onValueChange={(next) => setStage(next as AssembleStage)}
            options={STAGES.map((item) => ({ value: item, label: item === "screen" ? "Screen" : item[0]!.toUpperCase() + item.slice(1) }))} />
          <SegmentedControl ariaLabel="Density" size="sm" value={density} onValueChange={(next) => setDensity(next as SidebarDensity)}
            options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "touch", label: "Touch" }]} />
          <SegmentedControl ariaLabel="Hero theme" size="sm" value={themes[0] ?? "light"} onValueChange={(theme) => onChange({ theme: theme as ViewerState["theme"] })}
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          <SegmentedControl ariaLabel="Hero locale" size="sm" value={state.locale} onValueChange={(locale) => onChange({ locale: locale as ViewerState["locale"] })}
            options={[{ value: "en", label: "EN" }, { value: "ko", label: "KO" }]} />
          <Button size="sm" variant="borderless" text="Assemble again" data-ds-motion="assemble" onClick={replay} />
        </div>
      </section>

      <MetricGrid columns="4">
        <MetricCard label="Components" value={value(components)} />
        <MetricCard label="Blocks" value={value(blocks)} />
        <MetricCard label="Live stories" value={value(stories)} />
        <MetricCard label="Tokens from tokens.css" value={value(tokenCatalog.length)} />
      </MetricGrid>

      <Notice tone={guided === entries.length && readmes === entries.length ? "success" : "warning"} title="Coverage"
        message={`${entries.length} of ${entries.length} components and blocks have a showcase · ${guided} have usage guidance · ${readmes} have a README · ${matrices} have a states matrix.`} />

      <Section title="Start here" titleAs="h2">
        <div className={styles.cardGrid}>
          <StartCard icon={<MagicWand size="lg" />} title="Decision guide" body="Describe the job, get the component." onClick={() => onOpen("guide")} />
          <StartCard icon={<LayoutDashboard size="lg" />} title="Build a screen" body="Settings, conversation, sidebar, dashboard, dialogs and states, with exact JSX." count={`${RECIPES.length}`} onClick={() => onOpen("recipes")} />
          <StartCard icon={<Palette size="lg" />} title="Foundations" body="Every token, light and dark, generated from tokens.css." count={`${tokenCatalog.length}`} onClick={() => onOpen("foundations")} />
          <StartCard icon={<Sparkles size="lg" />} title="Components" body="Primitives with states matrices and usage guidance." count={`${components}`} onClick={() => onOpen("components")} />
          <StartCard icon={<Blocks size="lg" />} title="Blocks" body="Reusable compositions that product screens are built from." count={`${blocks}`} onClick={() => onOpen("blocks")} />
          <StartCard icon={<BookOpenText size="lg" />} title="Patterns" body="Glass, scroll fades, adaptive shell, Korean type, settings, drag and drop, queue." count={`${PATTERNS.length}`} onClick={() => onOpen("patterns")} />
          <StartCard icon={<Activity size="lg" />} title="Motion" body="Linear-crisp motion, played live with a reduced-motion switch." onClick={() => onOpen("motion")} />
          <StartCard icon={<ImageIcon size="lg" />} title="Icons" body="The icon set with names to copy." onClick={() => onOpen("icons")} />
        </div>
      </Section>

      <OverviewPrinciples />

      <Section title="Use it" titleAs="h2" description="Import from the public barrel. Never import component files, CSS modules or shadcn primitives directly.">
        <CodeSample code={'import { Button, ButtonContainer, SettingsField, Switch } from "@/butler-ds";'} />
      </Section>
    </Stack>
  );
}
