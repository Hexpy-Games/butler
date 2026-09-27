import type { CSSProperties } from "react";
import { NavRow } from "../../blocks/NavRow";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { MoreHorizontal, Plus } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { ChapterLayout, chapterSections, GuideSection, Specimen } from "./Chapter";
import type { ChapterProps } from "./chapterProps";
import { useTokenPx, WidthBars } from "./Measures";
import { px, useComputed } from "./measure";
import f from "./Foundations.module.css";

const tokens = (pattern: RegExp) => tokenCatalog.filter((token) => pattern.test(token.name));
const BUTTON_SIZE = { xs: "xs", sm: "sm", md: "default", lg: "lg" } as const;

/** A real Button at each control height, with its measured height checked against the token. */
function ControlRung({ name }: { name: string }) {
  const step = name.replace("--control-height-", "") as keyof typeof BUTTON_SIZE;
  const [ref, height] = useComputed<HTMLDivElement, number>((element) => px(`${element.querySelector("button")?.getBoundingClientRect().height ?? 0}`));
  const [values, probes] = useTokenPx([name]);
  const matches = height !== null && Math.abs(height - (values[name] ?? -1)) < 0.5;
  return (
    <div className={f.controlRung}>
      {probes}
      <span className={f.ruler} style={{ "--step": `var(${name})` } as CSSProperties} aria-hidden="true" />
      <div ref={ref}><Button size={BUTTON_SIZE[step] ?? "default"} text="Continue" /></div>
      <Stack gap="none" minWidth="0">
        <Typo.Code>{name}</Typo.Code>
        <Stack align="row" cross="center" gap="xs">
          <Typo.Caption tone="tertiary" numeric="tabular">{`${values[name] ?? ""}px · size="${BUTTON_SIZE[step] ?? "default"}"`}</Typo.Caption>
          {height !== null ? <Tag tone={matches ? "success" : "warning"}>{matches ? "matches" : `${height}px`}</Tag> : null}
        </Stack>
      </Stack>
    </div>
  );
}

function HitTargets() {
  return (
    <div className={f.hitGrid}>
      <Specimen caption="--control-hit-target · 30px pointer, 44px touch or ≤640px">
        <div className={f.hitStage}>
          <span className={f.hitArea} style={{ "--step": "var(--control-hit-target)" } as CSSProperties} aria-hidden="true" />
          <IconButton label="More"><MoreHorizontal size="md" /></IconButton>
        </div>
      </Specimen>
      <Specimen caption="--touch-target · 44px, the floor on touch">
        <div className={f.hitStage}>
          <span className={f.hitArea} style={{ "--step": "var(--touch-target)" } as CSSProperties} aria-hidden="true" />
          <IconButton label="Add"><Plus size="md" /></IconButton>
        </div>
      </Specimen>
      <Specimen caption="--menu-item-height · menu and list rows">
        <div className={f.menuSample}>
          <NavRow density="compact" label="Rename" />
          <NavRow density="compact" label="Move to project" />
        </div>
      </Specimen>
    </div>
  );
}

export function SizingChapter({ chapter, anchor, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [["controls", "Control heights"], ["hit-targets", "Hit targets"], ["chrome", "Chrome"]]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} onOpen={onOpen} sections={s.list}
      lead="Controls share four heights so rows line up across buttons, fields and segmented controls. Hit targets grow to 44px on touch, even when the glyph does not.">
      <GuideSection spec={s.at("controls")} lead="Button sizes map one to one onto --control-height-*. The badge checks the rendered height against the token.">
        <Stack gap="md">{tokens(/^--control-height-/u).map((token) => <ControlRung key={token.name} name={token.name} />)}</Stack>
      </GuideSection>
      <GuideSection spec={s.at("hit-targets")} lead="The dashed square is the target, not the drawing. IconButton pads itself up to it.">
        <HitTargets />
      </GuideSection>
      <GuideSection spec={s.at("chrome")} lead="Sidebar, panels and title bar, resolved at this viewport and scaled against the widest.">
        <WidthBars tokens={tokens(/^--(sidebar-width|right-panel-width|composer-reserve|traffic-controls-width|titlebar-height|adaptive-(drawer|inspector)-width)$/u)} />
      </GuideSection>
    </ChapterLayout>
  );
}
