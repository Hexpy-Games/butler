import type { CSSProperties } from "react";
import { KeyValueRow } from "../../blocks/KeyValueRow";
import { PromptFluidBackground } from "../../blocks/PromptSuggestionList";
import { Tag } from "../../components/Tag";
import { TintedGlass } from "../../components/TintedGlass";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ADAPTIVE_BREAKPOINTS } from "../../responsive";
import type { ShowcaseRenderContext } from "../../showcase";
import styles from "../DesignSystemViewer.module.css";

type AppLocale = ShowcaseRenderContext["locale"];

const GLASS = {
  "en-US": { title: "Glass over live content", body: "The fluid background keeps moving under the surface; the tint and the edge keep the text readable in both themes." },
  "ko-KR": { title: "움직이는 내용 위의 유리", body: "유체 배경이 표면 아래에서 계속 움직여도 틴트와 가장자리 덕분에 두 테마 모두에서 글이 잘 읽힙니다." },
} as const;

export function GlassOverContent({ locale }: { locale: AppLocale }) {
  return (
    <div className={styles.glassStage}>
      <div className={styles.heroFluid}><PromptFluidBackground /></div>
      <TintedGlass radius="composer" padding="lg">
        <Stack gap="xs">
          <Typo.PanelTitle>{GLASS[locale].title}</Typo.PanelTitle>
          <Typo.Body>{GLASS[locale].body}</Typo.Body>
        </Stack>
      </TintedGlass>
    </div>
  );
}

export function AdaptiveBreakpoints() {
  const rows = [
    ["Compact", `≤ ${ADAPTIVE_BREAKPOINTS.compactMax}px or coarse pointer`, "Drawers over a scrim, 44px touch targets, touch sidebar density, larger type roles"],
    ["Medium", `${ADAPTIVE_BREAKPOINTS.compactMax + 1}–${ADAPTIVE_BREAKPOINTS.mediumMax}px`, "Browser: side panels stay drawers; Electron: columns"],
    ["Expanded", `≥ ${ADAPTIVE_BREAKPOINTS.mediumMax + 1}px`, "Sidebar, workspace and inspector side by side"],
    ["Compact settings", "≤ 760px", "Single-pane SettingsShell, tighter section inset"],
  ] as const;
  return (
    <Stack gap="xs">
      {rows.map(([mode, range, behavior]) => (
        <KeyValueRow key={mode} label={mode} value={range} description={behavior} detailAlign="start" valueTextSize="caption" />
      ))}
    </Stack>
  );
}

const KOREAN = "Butler는 설정 페이지의 섹션 머리글을 카드 바깥에 두고, 카드 안쪽 필드 간격을 하나의 리듬으로 맞춥니다. 경로 /Users/butler/projects/design-system/viewer/tokens.css 같은 긴 토큰도 넘치지 않고 줄바꿈됩니다.";

export function KoreanWrapping() {
  return (
    <div className={styles.doDont}>
      <div className={styles.verdict} data-verdict="do">
        <div className={styles.verdictBody} lang="ko"><Typo.Body>{KOREAN}</Typo.Body></div>
        <div className={styles.verdictCaption}><Typo.Caption>keep-all (global rule): words stay whole</Typo.Caption></div>
      </div>
      <div className={styles.verdict} data-verdict="dont">
        <div className={styles.verdictBody} lang="ko" style={{ wordBreak: "break-all" }}><Typo.Body>{KOREAN}</Typo.Body></div>
        <div className={styles.verdictCaption}><Typo.Caption>break-all: words split mid-syllable (never)</Typo.Caption></div>
      </div>
    </div>
  );
}

const RAMP = [
  ["--settings-section-header-gap", "Section header → its card"],
  ["--settings-section-padding", "Card inset"],
  ["--settings-field-copy-gap", "Label → description"],
  ["--settings-field-control-gap", "Description → control"],
  ["--settings-field-gap", "Field → field"],
  ["--settings-section-gap", "Card → next section header"],
] as const;

export function SettingsRamp() {
  return (
    <Stack gap="sm">
      {RAMP.map(([token, meaning]) => (
        <Stack align="row" cross="center" gap="md" key={token}>
          <span className={styles.sampleSpace} style={{ "--sample": `var(${token})` } as CSSProperties} />
          <Typo.Code>{token}</Typo.Code>
          <Typo.Caption tone="secondary">{meaning}</Typo.Caption>
        </Stack>
      ))}
    </Stack>
  );
}

export function DropZoneDiagram() {
  return (
    <Stack gap="sm">
      <div className={styles.dropZones}>
        <span data-zone="before"><Tag>before · 25%</Tag></span>
        <span data-zone="group"><Tag tone="accent">group or inside · 50%</Tag></span>
        <span data-zone="after"><Tag>after · 25%</Tag></span>
      </div>
      <Typo.Caption tone="secondary">Zones come from layout boxes (offset geometry), so the slot and the lift never move them.</Typo.Caption>
    </Stack>
  );
}
