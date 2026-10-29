import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { CSSProperties, ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { ArrowLeft } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { clampBrowserChatWidth } from "../AdaptiveShell/conversationFrame";
import styles from "./TitlebarShell.module.css";
import { dsClass } from "../../lib/internal";

/** Up one level from a nested screen (서랍 › 스크랩 › 여행): a back button at the title's start. */
export interface TitlebarBack {
  /** “Back to Scraps” / “스크랩으로 돌아가기”; also the tooltip. */
  label: string;
  onBack: () => void;
}

export interface TitlebarShellProps extends DsPrivateStyleProps {
  title: ReactNode;
  /** Shown on nested screens only; top-level screens pass nothing. The App binds ⌘[ / Alt+← to the same action. */
  back?: TitlebarBack;
  subtitle?: ReactNode;
  /** Controls after the whole title line, title then subtitle (the conversation's ⋯ menu). */
  titleActions?: ReactNode;
  leading?: ReactNode;
  leadingVisibility?: "always" | "narrow";
  /** `glyph` (default): a square the size of the title line. `auto`: the control keeps its own size (a conversation button). */
  leadingSize?: "glyph" | "auto";
  /**
   * Controls at the chat card's trailing edge (the 세션 정보 toggle). They sit just before `trailing` while the
   * browser pane is closed and at the chat card's end while it is open (`splitChatWidth`).
   */
  chatTrailing?: ReactNode;
  /**
   * The chat column width in px while the browser pane is open: the same `chatWidth` AdaptiveShellSplit gets, in
   * the same render, so a drag moves both together. The title, titleActions and chatTrailing then span the chat
   * card and `trailing` stays over the pane. Omit while the pane is closed.
   */
  splitChatWidth?: number;
  trailing?: ReactNode;
  windowControls?: ReactNode;
  collapsed?: boolean;
  /** Makes the titlebar a window drag region (controls inside it stay clickable). */
  dragRegion?: boolean;
  dataTestClass?: string;
}

type TitlebarIdentityProps = Pick<TitlebarShellProps, "title" | "back" | "subtitle" | "titleActions" | "leading" | "leadingVisibility" | "leadingSize">;

/** Back, leading, then the title line: title, its actions and the subtitle (one baseline row). */
function TitlebarIdentity({ title, back, subtitle, titleActions, leading, leadingVisibility, leadingSize }: TitlebarIdentityProps) {
  return (
    <Stack align="row" cross="center" gap="sm" className={dsClass(styles.identity)}>
      {back ? (
        <span className={cn(styles.back, "no-drag")} data-slot="titlebar-back">
          <IconButton label={back.label} onClick={back.onBack} data-test-class="titlebar-back">
            <ArrowLeft size="md" />
          </IconButton>
        </span>
      ) : null}
      {leading ? (
        <span
          className={styles.leading}
          data-slot="titlebar-leading"
          data-visibility={leadingVisibility}
          data-size={leadingSize === "auto" ? "auto" : undefined}
        >
          {leading}
        </span>
      ) : null}
      <div className={styles.copy} data-title-actions={titleActions ? "" : undefined}>
        <Typo.AppTitle className={dsClass(styles.title)} data-slot="titlebar-title">
          {title}
        </Typo.AppTitle>
        {subtitle ? (
          <Typo.Caption className={dsClass(styles.subtitle)} data-slot="titlebar-subtitle">{subtitle}</Typo.Caption>
        ) : null}
        {/* After the subtitle, on screen and in reading order: title and subtitle read as one unit. */}
        {titleActions ? (
          <span className={cn(styles.titleActions, "no-drag")} data-slot="titlebar-title-actions">{titleActions}</span>
        ) : null}
      </div>
    </Stack>
  );
}

export function TitlebarShell({
  leadingVisibility = "always",
  leadingSize = "glyph",
  chatTrailing,
  splitChatWidth,
  trailing,
  windowControls,
  collapsed = false,
  dragRegion = false,
  className,
  dataTestClass,
  ...identityProps
}: TitlebarShellProps) {
  const split = splitChatWidth !== undefined;
  const grouped = Boolean(chatTrailing) || split;
  const identity = <TitlebarIdentity {...identityProps} leadingVisibility={leadingVisibility} leadingSize={leadingSize} />;
  return (
    <header
      className={cn(styles.titlebar, collapsed && styles.collapsed, dragRegion && "drag-region", className)}
      data-test-class={dataTestClass}
      data-grouped={grouped ? "" : undefined}
      data-split={split ? "" : undefined}
      style={split ? { "--titlebar-split-chat-width": `${clampBrowserChatWidth(splitChatWidth)}px` } as CSSProperties : undefined}
    >
      {grouped ? (
        <div className={styles.chatGroup} data-slot="titlebar-chat-group">
          {identity}
          {chatTrailing ? (
            <div className={cn(styles.trailing, "no-drag")} data-slot="titlebar-chat-trailing">{chatTrailing}</div>
          ) : null}
        </div>
      ) : identity}
      {trailing ? (
        <div className={cn(styles.trailing, "no-drag")}>{trailing}</div>
      ) : null}
      {windowControls ? (
        <div className={cn(styles.windowControls, "no-drag")}>
          {windowControls}
        </div>
      ) : null}
    </header>
  );
}
