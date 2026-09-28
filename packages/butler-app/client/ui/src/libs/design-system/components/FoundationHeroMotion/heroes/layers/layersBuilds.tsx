import { NavRow } from "../../../../blocks/NavRow";
import tip from "../../../../shadcn/ui/tooltip.module.css";
import { Box } from "../../../Box";
import { FieldLabel } from "../../../Field";
import { IconButton } from "../../../IconButton";
import { Folder, MessageSquare, MoreHorizontal, Search, Settings } from "../../../Icons";
import { SelectButton } from "../../../Select";
import { Stack } from "../../../Stack";
import { tintedGlassSurfaceClassName } from "../../../TintedGlass";
import { Typo } from "../../../Typo";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { Annot, BuildSpec } from "../shared/types";
import { zValue, type LayersCopy } from "./layersCopy";
import s from "./LayersHero.module.css";

/** A badge naming a layer's z token and its value. */
const z = (target: string, name: string): Annot => ({ kind: "tag", target, label: [`--z-${name}`, `--z-${name} · ${zValue(name)}`] });

/**
 * Components by topic (sticky header, drawer, dialog with an open select,
 * tooltip): each built from its blueprint, its layers stacking in order,
 * each layer badged with its z token.
 */
export function layersBuilds(copy: LayersCopy): BuildSpec[] {
  const { topics } = copy;
  const rows = [copy.weekly, copy.plan, copy.notes];
  return [
    {
      id: "sticky",
      render: (
        <Topic id="t1" title={topics.sticky}>
          <Mark block n="panel" sketch>
            <Box border="hairline" radius="panel" surface="raised">
              <Mark block fill n="head"><div className={s.stickyHead}><Typo.PanelTitle><R name="h-t">{copy.inbox}</R></Typo.PanelTitle><IconButton label={copy.inbox}><MoreHorizontal size="md" /></IconButton></div></Mark>
              <div className={s.listBody}>{rows.map((row, k) => <div className={s.listRow} key={row}><Typo.Body><R name={`r${k}`}>{row}</R></Typo.Body></div>)}</div>
            </Box>
          </Mark>
        </Topic>
      ),
      steps: [{ text: ["t1-topic"] }, { text: ["r0", "r1", "r2"] }, { parts: ["head"], text: ["h-t"], annots: [z("head", "sticky")] }],
    },
    {
      id: "drawer",
      render: (
        <Topic id="t2" title={topics.drawer}>
          <Mark block n="win" sketch>
            <div className={s.window}>
              <div className={s.windowPage}>{rows.map((row) => <span className={s.pageLine} key={row} />)}</div>
              <Mark block fill n="dim"><span className={s.dim} /></Mark>
              <Mark block fill n="drawer" sketch>
                <div className={s.drawer}>
                  <NavRow active icon={<MessageSquare size="sm" />} label={<R name="d0">{copy.chats}</R>} />
                  <NavRow icon={<Folder size="sm" />} label={<R name="d1">{copy.projects}</R>} />
                  <NavRow icon={<Search size="sm" />} label={<R name="d2">{copy.files}</R>} />
                </div>
              </Mark>
            </div>
          </Mark>
        </Topic>
      ),
      steps: [{ text: ["t2-topic"] }, { parts: ["dim"], annots: [z("dim", "overlay")] }, { parts: ["drawer"], text: ["d0", "d1", "d2"], annots: [z("drawer", "drawer")] }],
    },
    {
      id: "dialog",
      render: (
        <Topic id="t3" title={topics.dialog}>
          <div className={s.dialogStage}>
            <Mark block fill n="dlg" sketch>
              <Box border="hairline" padding="lg" radius="popover" surface="overlay">
                <Stack gap="md">
                  <Typo.H5 as="span"><R name="g-t">{copy.dialogTitle}</R></Typo.H5>
                  <Stack gap="xs"><FieldLabel><R name="g-l">{copy.project}</R></FieldLabel><Mark n="trigger" part><SelectButton><R name="g-v">{copy.pick}</R></SelectButton></Mark></Stack>
                </Stack>
              </Box>
            </Mark>
            <Mark block fill n="list" sketch>
              <div className={s.listbox}>
                <Box border="hairline" padding="xs" radius="popover" surface="overlay">
                  {[copy.pick, copy.other].map((item, k) => <div className={s.option} data-on={k === 0 ? "" : undefined} key={item}><Typo.Body><R name={`o${k}`}>{item}</R></Typo.Body></div>)}
                </Box>
              </div>
            </Mark>
          </div>
        </Topic>
      ),
      steps: [{ text: ["t3-topic"] }, { parts: ["dlg"], text: ["g-t", "g-l"], annots: [z("dlg", "dialog")] }, { parts: ["trigger", "list"], text: ["g-v", "o0", "o1"], annots: [z("list", "popover")] }],
    },
    {
      id: "tooltip",
      render: (
        <Topic id="t4" title={topics.tooltip}>
          <div className={s.tipStage}>
            <Mark fill n="bubble"><span className={s.tipAnchor}><span className={`${tintedGlassSurfaceClassName} ${tip.tooltip}`}><R name="tip-t">{copy.tip}</R></span></span></Mark>
            <Mark n="btn" part sketch><IconButton label={copy.settings}><Settings size="md" /></IconButton></Mark>
          </div>
        </Topic>
      ),
      steps: [{ text: ["t4-topic"] }, { parts: ["btn"] }, { parts: ["bubble"], text: ["tip-t"], annots: [z("bubble", "tooltip")] }],
    },
  ];
}
