import type { ReactNode } from "react";
import {
  Box, Button, ButtonContainer, ButlerThinkingMark, RollingStatusLine, RollingSwap, Stack, TintedGlass, Tooltip, Typo,
} from "@/butler-ds";
import type { WindowCopy } from "./copy";
import { markWorking, type LifecycleKind, type LifecycleVariant, type QuitState, type StartupState } from "./state";

export interface LifecycleContent {
  title: string;
  /** The live stage line: one line, rolls (RollingSwap) when the stage changes. */
  line?: { text: string; key: string };
  /** A failure reason or consequence: wraps, never truncates. */
  detail?: string;
  /** The slow hint under the stage line. */
  caption?: string;
  /** `hint` is the destructive action's consequence (its tooltip and accessible description). */
  actions?: { secondary: string; primary: string; destructive: boolean; hint?: string };
  working: boolean;
  /** Failure titles are announced at once; stage lines politely. */
  alert: boolean;
}

/** Window copy for one state: the single source both the page and the static build read. */
export function lifecycleContent(kind: LifecycleKind, state: StartupState | QuitState, copy: WindowCopy): LifecycleContent {
  const working = markWorking(kind, state);
  if (kind === "startup") {
    const startup = state as StartupState;
    if (startup === "error") {
      return { title: copy.startupFailed, detail: copy.startupReasons.engine, working, alert: true,
        actions: { secondary: copy.openLog, primary: copy.retry, destructive: false } };
    }
    const stage = startup === "slow" ? "engine" : startup;
    return { title: copy.startupTitle, line: { text: copy.startupStages[stage], key: stage }, working, alert: false,
      caption: startup === "slow" ? copy.slow : undefined };
  }
  const quit = state as QuitState;
  const force = { secondary: copy.openLog, primary: copy.forceQuit, destructive: true, hint: copy.forceHint };
  if (quit === "failed") return { title: copy.quitFailed, detail: copy.forceHint, working, alert: true, actions: force };
  const stage = quit === "timeout" ? "storage" : quit;
  return { title: copy.quitTitle, line: { text: copy.quitStages[stage], key: stage }, working, alert: false,
    actions: quit === "timeout" ? force : undefined };
}

function Mark({ size, working, reducedMotion, theme }: { size: "card" | "strip"; working: boolean; reducedMotion: boolean; theme: "light" | "dark" }) {
  const state = working ? "working" : "idle";
  // Explicit ink: the mark resolves its theme scope once at mount (markLoop.ts), so a live theme switch needs the prop.
  // DS gap: IconSize stops at 2xl (32px). The card's 48px brand mark is a proposal-only size.
  if (size === "card") {
    return (
      <Stack gap="none" UNSAFE_style={{ width: 48, height: 48 }}>
        <ButlerThinkingMark state={state} theme={theme} reducedMotion={reducedMotion} morphKey="lifecycle" />
      </Stack>
    );
  }
  return <ButlerThinkingMark state={state} theme={theme} size="2xl" reducedMotion={reducedMotion} morphKey="lifecycle" />;
}

function Text({ content, align }: { content: LifecycleContent; align: "center" | "start" }) {
  return (
    <Stack gap="xs" cross={align === "center" ? "center" : "stretch"} fill>
      <Typo.AppTitle align={align} truncate role={content.alert ? "alert" : undefined}>{content.title}</Typo.AppTitle>
      {content.line ? (
        <RollingStatusLine role="status" aria-live="polite">
          <RollingSwap itemKey={content.line.key}>
            <Typo.Body tone="secondary" align={align}>{content.line.text}</Typo.Body>
          </RollingSwap>
        </RollingStatusLine>
      ) : null}
      {content.detail ? <Typo.Body tone="secondary" align={align}>{content.detail}</Typo.Body> : null}
      {content.caption ? <Typo.Caption tone="tertiary" align={align}>{content.caption}</Typo.Caption> : null}
    </Stack>
  );
}

function Actions({ content, justify, onAction }: { content: LifecycleContent; justify: "center" | "start"; onAction?: (action: string) => void }) {
  if (!content.actions) return null;
  const { secondary, primary, destructive, hint } = content.actions;
  const button = (
    <Button size="sm" variant={destructive ? "destructive" : "default"} aria-description={hint}
      onClick={() => onAction?.(destructive ? "force" : "retry")}>{primary}</Button>
  );
  return (
    <ButtonContainer size="sm" justify={justify} windowDrag="no-drag">
      <Button size="sm" variant="secondary" onClick={() => onAction?.("log")}>{secondary}</Button>
      {hint && !content.detail ? <Tooltip label={hint}>{button}</Tooltip> : button}
    </ButtonContainer>
  );
}

/**
 * One lifecycle window's content at its real size: the backdrop (passed in) fills the window and every
 * word sits on a TintedGlass card. Variant A centres a 264px card; B fills the window with a row card.
 */
export function LifecycleWindow({ variant, content, reducedMotion, theme, backdrop, onAction, cardRef }: {
  variant: LifecycleVariant;
  theme: "light" | "dark";
  content: LifecycleContent;
  reducedMotion: boolean;
  backdrop: ReactNode;
  onAction?: (action: string) => void;
  /** The card's box, measured for the wallpaper's `contentRect` (modules compose around it). */
  cardRef?: (node: HTMLDivElement | null) => void;
}) {
  const card = variant === "card";
  return (
    <Stack gap="none" UNSAFE_style={{ height: "100dvh", "--workspace-left-radius": "0px" }}>
    <Box surface="base" grow>
      {backdrop}
      <Stack windowDrag="drag" justify="center" cross="center" gap="none" UNSAFE_style={{ height: "100%" }}>
        <Stack gap="none" UNSAFE_style={{ width: card ? 296 : "100%" }}>
        <div ref={cardRef}>
        <Box padding="lg">
          <TintedGlass radius="panel" padding="lg">
            {card ? (
              <Stack gap="md" cross="center">
                <Mark size="card" working={content.working} reducedMotion={reducedMotion} theme={theme} />
                <Text content={content} align="center" />
                <Actions content={content} justify="center" onAction={onAction} />
              </Stack>
            ) : (
              <Stack align="row" gap="md" cross="start">
                <Mark size="strip" working={content.working} reducedMotion={reducedMotion} theme={theme} />
                <Stack gap="md" fill>
                  <Text content={content} align="start" />
                  <Actions content={content} justify="start" onAction={onAction} />
                </Stack>
              </Stack>
            )}
          </TintedGlass>
        </Box>
        </div>
        </Stack>
      </Stack>
    </Box>
    </Stack>
  );
}
