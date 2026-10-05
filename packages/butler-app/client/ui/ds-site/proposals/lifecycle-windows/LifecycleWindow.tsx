import type { ReactNode } from "react";
import {
  Box, Button, ButtonContainer, ButlerThinkingMark, RollingStatusLine, RollingSwap, Stack, SurfacePanel, Tooltip, Typo,
  type UnsafeStyle,
} from "@/butler-ds";
import tokensCss from "@/butler-ds/tokens.css?raw";
import type { WindowCopy } from "./copy";
import { markWorking, type LifecycleKind, type LifecycleSurface, type QuitState, type StartupState } from "./state";

export interface LifecycleContent {
  title: string;
  /** The live stage line: one line, rolls (RollingSwap) when the stage changes. */
  line?: { text: string; key: string };
  /** A failure reason or consequence: wraps (keep-all), never truncates. */
  detail?: string;
  /** The slow hint under the stage line. */
  caption?: string;
  /** `hint` is the destructive action's consequence (its tooltip and accessible description). */
  actions?: { secondary: string; primary?: string; destructive?: boolean; hint?: string };
  working: boolean;
  /** Failure titles are announced at once; stage lines politely. */
  alert: boolean;
}

/** Window copy for one state: the single source both the page and the static build read. */
export function lifecycleContent(kind: LifecycleKind, state: StartupState | QuitState, copy: WindowCopy, forceQuit = false): LifecycleContent {
  const working = markWorking(kind, state);
  if (kind === "startup") {
    const startup = state as StartupState;
    if (startup === "error") {
      return { title: copy.startupFailed, detail: copy.startupReasons.service, working, alert: true,
        actions: { secondary: copy.openLog, primary: copy.retry, destructive: false } };
    }
    const stage = startup === "slow" ? "service" : startup;
    return { title: copy.startupTitle, line: { text: copy.startupStages[stage], key: stage }, working, alert: false,
      caption: startup === "slow" ? copy.slow : undefined };
  }
  const quit = state as QuitState;
  // Force quit only behind the flag (needs a supervisor forceStop); without it the user can only open the log.
  const actions = forceQuit
    ? { secondary: copy.openLog, primary: copy.forceQuit, destructive: true, hint: copy.forceHint }
    : { secondary: copy.openLog };
  if (quit === "failed") {
    return { title: copy.quitFailed, detail: forceQuit ? copy.forceHint : undefined, working, alert: true, actions };
  }
  const stage = quit === "timeout" ? "storage" : quit;
  return { title: copy.quitTitle, line: { text: copy.quitStages[stage], key: stage }, working, alert: false,
    caption: quit === "timeout" && !forceQuit ? copy.slow : undefined,
    actions: quit === "timeout" ? actions : undefined };
}

/**
 * DS GAP WORKAROUND (proposal-only). The window is 360px wide, so every `(width <= 640px)` rule in the
 * DS fires as if it were a phone: the type ramp grows (body 14 → 16, app title 15 → 17, caption
 * 12 → 14; tokens.css:758-795) and buttons get a 44px floor (--control-hit-target, tokens.css:663-667,
 * Button.module.css:163-166). A desktop window with a fine pointer must keep the desktop scale, so the
 * root re-declares every phone-overridden token (and its dependents) with its desktop :root value, read
 * from tokens.css itself (no copied numbers).
 * Proposed DS fix: a `[data-viewport="desktop"]` scope (like `[data-motion="reduced"]`) that does this.
 */
const desktopRoot = new Map([...(tokensCss.split("\n}")[0] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map((m) => [m[1]!, m[2]!.trim()]));
const phoneNames = new Set([...tokensCss.matchAll(/@media \((?:width <= 640px|width <= 640px\), \(pointer: coarse)\)\s*\{\s*:root\s*\{([^}]*)\}/gu)]
  .flatMap((m) => [...m[1]!.matchAll(/(--[\w-]+):/gu)].map((d) => d[1]!)));
// Tokens derived from a phone-overridden one (e.g. --font-size-3: var(--typo-body-size)) resolve at :root,
// so they are re-declared here too and re-resolve against the pinned values.
for (let grew = true; grew;) {
  grew = false;
  for (const [name, value] of desktopRoot) {
    if (phoneNames.has(name)) continue;
    if ([...value.matchAll(/var\((--[\w-]+)/gu)].some((m) => phoneNames.has(m[1]!))) { phoneNames.add(name); grew = true; }
  }
}
const DESKTOP_SCOPE = Object.fromEntries([...phoneNames].filter((name) => desktopRoot.has(name))
  .map((name) => [name, desktopRoot.get(name)])) as UnsafeStyle;
if (!("--control-hit-target" in DESKTOP_SCOPE) || !("--typo-body-size" in DESKTOP_SCOPE)) throw new Error("DS phone tokens not found");
// The phone *rule* (Button.module.css:163-166, `min-height: var(--control-hit-target)`) still matches in a
// 360px viewport; with the desktop 30px value it would lift size="sm" (28px) to 30px. A 0px floor makes
// the rule inert, so every Button keeps exactly its own --control-height-* (nothing else here reads it).
DESKTOP_SCOPE["--control-hit-target"] = "0px";

function Mark({ working, reducedMotion, theme }: { working: boolean; reducedMotion: boolean; theme: "light" | "dark" }) {
  // DS gap: IconSize stops at 2xl (32px). The 48px brand mark is a proposal-only size.
  // Explicit ink: the mark resolves its theme scope once at mount (markLoop.ts), so a live theme switch needs the prop.
  return (
    <Stack gap="none" UNSAFE_style={{ width: 48, height: 48 }}>
      <ButlerThinkingMark state={working ? "working" : "idle"} theme={theme} reducedMotion={reducedMotion} morphKey="lifecycle" />
    </Stack>
  );
}

function Text({ content }: { content: LifecycleContent }) {
  return (
    <Stack gap="xs" cross="center">
      <Typo.AppTitle align="center" tone="primary" role={content.alert ? "alert" : undefined}>{content.title}</Typo.AppTitle>
      {content.line ? (
        <RollingStatusLine role="status" aria-live="polite">
          <RollingSwap itemKey={content.line.key}>
            <Typo.Body tone="secondary" align="center">{content.line.text}</Typo.Body>
          </RollingSwap>
        </RollingStatusLine>
      ) : null}
      {content.detail ? <Typo.Body tone="secondary" align="center">{content.detail}</Typo.Body> : null}
      {content.caption ? <Typo.Caption tone="tertiary" align="center">{content.caption}</Typo.Caption> : null}
    </Stack>
  );
}

function Actions({ content, onAction }: { content: LifecycleContent; onAction?: (action: string) => void }) {
  if (!content.actions) return null;
  const { secondary, primary, destructive, hint } = content.actions;
  const button = primary === undefined ? null : (
    <Button size="sm" variant={destructive ? "destructive" : "default"} aria-description={hint}
      onClick={() => onAction?.(destructive ? "force" : "retry")}>{primary}</Button>
  );
  return (
    <ButtonContainer size="sm" justify="center" windowDrag="no-drag">
      <Button size="sm" variant="secondary" onClick={() => onAction?.("log")}>{secondary}</Button>
      {hint && !content.detail ? <Tooltip label={hint}>{button}</Tooltip> : button}
    </ButtonContainer>
  );
}

/**
 * The card's surface. Recommended `box`: Box surface="raised" (solid --surface-raised, 96% opaque),
 * hairline --line border, --radius-panel and the lg inset: the DS "single surface" primitive.
 * `panel`: SurfacePanel elevation="medium" (same --surface-raised plus --shadow-card, but its fixed
 * --radius-control corners and md inset read as a list card, not a window's only content).
 */
function Surface({ surface, children }: { surface: LifecycleSurface; children: ReactNode }) {
  if (surface === "panel") return <SurfacePanel elevation="medium">{children}</SurfacePanel>;
  return <Box surface="raised" border="hairline" radius="panel" padding="lg">{children}</Box>;
}

/**
 * One lifecycle window at its real size: the wallpaper still (passed in) fills the window and every
 * word sits on one solid DS surface centred on it, never on the art itself.
 */
export function LifecycleWindow({ content, surface, reducedMotion, theme, backdrop, onAction, cardRef }: {
  content: LifecycleContent;
  surface: LifecycleSurface;
  theme: "light" | "dark";
  reducedMotion: boolean;
  backdrop: ReactNode;
  onAction?: (action: string) => void;
  /** The card's box, measured for the wallpaper's `contentRect` (modules compose around it). */
  cardRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <Stack gap="none" UNSAFE_style={{ height: "100dvh", "--workspace-left-radius": "0px", ...DESKTOP_SCOPE }}>
      <Box surface="base" grow>
        {backdrop}
        <Stack windowDrag="drag" justify="center" cross="center" gap="none" UNSAFE_style={{ height: "100%" }}>
          <Stack gap="none" UNSAFE_style={{ width: 296 }}>
            {/* DS GAP WORKAROUND (proposal-only): the Wallpaper layer is position: fixed; z-index: 0
                (Wallpaper.module.css:1-17) and no public layout primitive lifts content above it; only blocks
                do it privately (SetupWizardShell.module.css:23-24). A positioned wrapper paints the card after
                the wallpaper in tree order. No surface, colour or spacing comes from here. */}
            <div ref={cardRef} style={{ position: "relative" }}>
              <Surface surface={surface}>
                <Stack gap="md" cross="center">
                  <Mark working={content.working} reducedMotion={reducedMotion} theme={theme} />
                  <Text content={content} />
                  <Actions content={content} onAction={onAction} />
                </Stack>
              </Surface>
            </div>
          </Stack>
        </Stack>
      </Box>
    </Stack>
  );
}
