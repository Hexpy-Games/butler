import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { SurfacePanel } from "../../../../blocks/SurfacePanel";
import { Box } from "../../../Box";
import { IconButton } from "../../../IconButton";
import { Plus } from "../../../Icons";
import { SegmentedControl } from "../../../SegmentedControl";
import { Stack } from "../../../Stack";
import { Switch } from "../../../Switch";
import { Typo } from "../../../Typo";
import { valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { BuildSpec } from "../shared/types";
import type { RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/**
 * Components by topic (controls, surface, overlay, composer): each drawn as
 * its blueprint with its real corners, filled, then its radius circle and
 * its shadow's guides applied with badges naming the tokens.
 */
export function radiusBuilds(copy: RadiusCopy): BuildSpec[] {
  const { topics } = copy;
  return [
    {
      id: "controls",
      render: (
        <Topic id="t1" title={topics.controls}>
          <div className={s.row}>
            <Mark n="seg" part sketch>
              <SegmentedControl ariaLabel={copy.week} onValueChange={() => undefined} value="week"
                options={[{ value: "day", label: <R name="seg-0">{copy.day}</R> }, { value: "week", label: <R name="seg-1">{copy.week}</R> }, { value: "month", label: <R name="seg-2">{copy.month}</R> }]} />
            </Mark>
            <Mark n="sw" part sketch><Switch aria-label={copy.autoSave} checked onCheckedChange={() => undefined} /></Mark>
          </div>
        </Topic>
      ),
      steps: [
        { text: ["t1-topic"] },
        { parts: ["seg"], text: ["seg-0", "seg-1", "seg-2"], annots: [{ kind: "radius", target: "seg", label: valueLabel("--radius-control") }] },
        { parts: ["sw"], annots: [{ kind: "radius", target: "sw", label: valueLabel("--radius-pill") }] },
      ],
    },
    {
      id: "surface",
      render: (
        <Topic id="t2" title={topics.surface}>
          <Mark block fill n="panel" sketch>
            <SurfacePanel elevation="medium">
              <Stack gap="xs">
                <Typo.Label as="span"><R name="p-title">{copy.panelTitle}</R></Typo.Label>
                <Typo.Body tone="secondary"><R name="p-body">{copy.panelBody}</R></Typo.Body>
              </Stack>
            </SurfacePanel>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t2-topic"] },
        { parts: ["panel"], annots: [{ kind: "radius", target: "panel", label: valueLabel("--radius-control") }] },
        { text: ["p-title", "p-body"], annots: [{ kind: "shadow", target: "panel", label: valueLabel("--shadow-card") }] },
      ],
    },
    {
      id: "overlay",
      render: (
        <Topic id="t3" title={topics.overlay}>
          <Mark block fill n="menu" sketch>
            <Box border="hairline" padding="xs" radius="popover" surface="overlay">
              {[copy.rename, copy.duplicate, copy.archive].map((item, k) => <div className={s.menuRow} key={item}><Typo.Body><R name={`m-${k}`}>{item}</R></Typo.Body></div>)}
            </Box>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t3-topic"] },
        { parts: ["menu"], annots: [{ kind: "radius", target: "menu", label: valueLabel("--radius-popover") }] },
        { text: ["m-0", "m-1", "m-2"] },
      ],
    },
    {
      id: "composer",
      render: (
        <Topic id="t4" title={topics.composer}>
          <Mark block fill n="composer" sketch>
            <ComposerCard>
              <ComposerCardExpandedBody>
                <ComposerCardEditor>
                  <ComposerCardEditable><div /></ComposerCardEditable>
                  <ComposerCardPlaceholder><R name="c-ph">{copy.placeholder}</R></ComposerCardPlaceholder>
                </ComposerCardEditor>
              </ComposerCardExpandedBody>
              <ComposerCardToolbar>
                <Mark n="c-more" part><IconButton label={copy.more}><Plus size="md" /></IconButton></Mark>
                <ComposerCardToolbarSpacer />
                <Mark n="c-send" part sketch><ComposerSendButton aria-label={copy.send} mode="send" /></Mark>
              </ComposerCardToolbar>
            </ComposerCard>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t4-topic"] },
        { parts: ["composer"], annots: [{ kind: "radius", target: "composer", label: valueLabel("--adaptive-composer-radius") }] },
        { text: ["c-ph"], parts: ["c-more"] },
        { parts: ["c-send"], annots: [{ kind: "radius", target: "c-send", label: valueLabel("--radius-pill") }] },
      ],
    },
  ];
}
