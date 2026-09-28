import type { ReactElement } from "react";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { IconButton } from "../../../IconButton";
import { Archive, CheckCircle2, Copy, FolderPlus, PencilLine, Plus, Settings, Sparkles } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Tag } from "../../../Tag";
import { Typo } from "../../../Typo";
import { valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { BuildSpec } from "../shared/types";
import type { IconCopy } from "./iconCopy";
import s from "./IconHero.module.css";

const ICON: Record<number, string> = { 12: "xs", 14: "sm", 16: "md", 20: "lg", 24: "xl", 32: "2xl" };
/** A glyph's measured width under its --icon-size-* token. */
const size = valueLabel((px) => (ICON[Math.round(px)] ? `--icon-size-${ICON[Math.round(px)]}` : `${Math.round(px)}px`));

/**
 * Components by topic (actions, labels, empty state, menu): each drawn as
 * its blueprint, filled, then each glyph measured with a badge naming its
 * size token.
 */
export function iconBuilds(copy: IconCopy): BuildSpec[] {
  const { topics } = copy;
  const menu: Array<[string, ReactElement]> = [[copy.rename, <PencilLine key="a" size="md" />], [copy.duplicate, <Copy key="b" size="md" />], [copy.archive, <Archive key="c" size="md" />]];
  return [
    {
      id: "actions",
      render: (
        <Topic id="t1" title={topics.actions}>
          <div className={s.buildRow}>
            <Mark n="a1" part sketch><IconButton label={copy.settings}><Mark n="a1-g"><Settings size="md" /></Mark></IconButton></Mark>
            <Mark n="a2" part sketch><Button iconStart={<Mark n="a2-g"><Plus size="md" /></Mark>} text={<R name="a2-t">{copy.newChat}</R>} variant="outline" /></Mark>
          </div>
        </Topic>
      ),
      steps: [
        { text: ["t1-topic"] },
        { parts: ["a1"], annots: [{ kind: "size", target: "a1-g", axis: "w", label: size }] },
        { parts: ["a2"], text: ["a2-t"], annots: [{ kind: "center", target: "a2", axis: "h" }] },
      ],
    },
    {
      id: "labels",
      render: (
        <Topic id="t2" title={topics.labels}>
          <div className={s.buildRow}>
            <Mark n="l1" part sketch><Tag icon={<Mark n="l1-g"><Sparkles size="xs" /></Mark>} tone="accent"><R name="l1-t">{copy.beta}</R></Tag></Mark>
            <Mark n="l2" part sketch><Tag icon={<CheckCircle2 size="xs" />} tone="success"><R name="l2-t">{copy.synced}</R></Tag></Mark>
          </div>
        </Topic>
      ),
      steps: [
        { text: ["t2-topic"] },
        { parts: ["l1"], text: ["l1-t"], annots: [{ kind: "size", target: "l1-g", axis: "w", label: size }] },
        { parts: ["l2"], text: ["l2-t"], secondary: true },
      ],
    },
    {
      id: "empty",
      render: (
        <Topic id="t3" title={topics.empty}>
          <Mark block n="e" sketch>
            <Box border="hairline" padding="lg" radius="panel" surface="raised">
              <Stack align="column" cross="center" gap="sm">
                <Mark n="e-g" part><span className={s.muted}><FolderPlus size="2xl" /></span></Mark>
                <Typo.Label as="span"><R name="e-title">{copy.emptyTitle}</R></Typo.Label>
                <Typo.Caption tone="secondary"><R name="e-hint">{copy.emptyHint}</R></Typo.Caption>
                <Mark n="e-btn" part><Button size="sm" text={<R name="e-btn-t">{copy.create}</R>} /></Mark>
              </Stack>
            </Box>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t3-topic"] },
        { parts: ["e-g"], annots: [{ kind: "size", target: "e-g", axis: "w", label: size }, { kind: "tag", target: "e-g", label: ["--icon-muted"] }] },
        { text: ["e-title", "e-hint"] },
        { parts: ["e-btn"], text: ["e-btn-t"], secondary: true },
      ],
    },
    {
      id: "menu",
      render: (
        <Topic id="t4" title={topics.menu}>
          <Box border="hairline" padding="xs" radius="popover" surface="overlay">
            {menu.map(([label, glyph], k) => (
              <div className={s.menuRow} key={label}>
                <Mark n={`m${k}-g`} part>{glyph}</Mark>
                <Typo.Body><R name={`m${k}`}>{label}</R></Typo.Body>
              </div>
            ))}
          </Box>
        </Topic>
      ),
      steps: [
        { text: ["t4-topic"] },
        { parts: ["m0-g"], text: ["m0"], annots: [{ kind: "size", target: "m0-g", axis: "w", label: size }] },
        { parts: ["m1-g"], text: ["m1"], secondary: true },
        { parts: ["m2-g"], text: ["m2"], secondary: true, annots: [{ kind: "center", target: "m0-g", axis: "v" }] },
      ],
    },
  ];
}
