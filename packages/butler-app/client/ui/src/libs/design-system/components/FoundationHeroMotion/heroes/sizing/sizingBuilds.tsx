import { NavRow } from "../../../../blocks/NavRow";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { Button } from "../../../Button";
import { Folder, MessageSquare, PanelLeft, Plus, Search, Settings } from "../../../Icons";
import { Input } from "../../../Input";
import { Label } from "../../../Label";
import { SelectButton } from "../../../Select";
import { Switch } from "../../../Switch";
import { heightToken, valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { BuildSpec } from "../shared/types";
import type { SizingCopy } from "./sizingCopy";
import s from "./SizingHero.module.css";

const height = valueLabel(heightToken);

/**
 * Components by topic (controls, titlebar, sidebar, form row): each is drawn
 * as its blueprint, filled, then measured with height brackets and badges
 * naming the heights they sit on.
 */
export function sizingBuilds(copy: SizingCopy): BuildSpec[] {
  const { topics } = copy;
  return [
    {
      id: "controls",
      render: (
        <Topic id="t1" title={topics.controls}>
          <Mark block n="ctlrow">
            <div className={s.row}>
              <Mark block n="in" sketch sweep><Input readOnly value={copy.query} /></Mark>
              <Mark n="go" part sketch><Button text={<R name="go-t">{copy.find}</R>} /></Mark>
            </div>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t1-topic"] },
        { parts: ["in"], annots: [{ kind: "center", target: "ctlrow", axis: "h" }] },
        { parts: ["go"], text: ["go-t"], annots: [{ kind: "size", target: "go", axis: "h", label: height }] },
      ],
    },
    {
      id: "titlebar",
      render: (
        <Topic id="t2" title={topics.titlebar}>
          <Mark block n="tb" sketch>
            <div className={s.titlebarHost}>
            <TitlebarShell title={<R name="tb-title">{copy.title2}</R>} subtitle={<R name="tb-sub">{copy.subtitle}</R>}
              leading={<Mark n="tb-lead" part><Button aria-label={copy.title2} iconStart={<PanelLeft size="md" />} size="icon-sm" variant="ghost" /></Mark>}
              trailing={<span className={s.row}>
                <Mark n="tb-new" part><Button aria-label={copy.newChat} iconStart={<Plus size="md" />} size="icon-sm" variant="ghost" /></Mark>
                <Mark n="tb-set" part><Button aria-label={copy.settings} iconStart={<Settings size="md" />} size="icon-sm" variant="ghost" /></Mark>
              </span>} />
            </div>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t2-topic"], annots: [{ kind: "size", target: "tb", axis: "h", label: valueLabel("--titlebar-height") }] },
        { parts: ["tb-lead"], text: ["tb-title", "tb-sub"] },
        { parts: ["tb-new", "tb-set"], annots: [{ kind: "size", target: "tb-new", axis: "h", label: height }] },
      ],
    },
    {
      id: "sidebar",
      render: (
        <Topic id="t3" title={topics.sidebar}>
          <div className={s.sidebarStrip}>
            <Mark block n="r1"><NavRow active icon={<Mark n="r1-i" part><MessageSquare size="sm" /></Mark>} label={<R name="r1-t">{copy.chats}</R>} /></Mark>
            <Mark block n="r2"><NavRow icon={<Mark n="r2-i" part><Folder size="sm" /></Mark>} label={<R name="r2-t">{copy.projects}</R>} /></Mark>
            <Mark block n="r3"><NavRow icon={<Mark n="r3-i" part><Search size="sm" /></Mark>} label={<R name="r3-t">{copy.files}</R>} /></Mark>
          </div>
        </Topic>
      ),
      steps: [
        { text: ["t3-topic"] },
        { parts: ["r1-i"], text: ["r1-t"], annots: [{ kind: "size", target: "r1", axis: "h", label: valueLabel("--sidebar-row-height") }] },
        { parts: ["r2-i"], text: ["r2-t"], secondary: true },
        { parts: ["r3-i"], text: ["r3-t"], secondary: true },
      ],
    },
    {
      id: "form",
      render: (
        <Topic id="t4" title={topics.form}>
          <Mark block n="formrow">
            <div className={s.row}>
              <Mark n="sel" part sketch><SelectButton><R name="sel-t">{copy.auto}</R></SelectButton></Mark>
              <span className={s.nowrap}><Label><Mark n="sw" part sketch><Switch aria-label={copy.autoSend} checked onCheckedChange={() => undefined} /></Mark><R name="sw-t">{copy.autoSend}</R></Label></span>
            </div>
          </Mark>
        </Topic>
      ),
      steps: [
        { text: ["t4-topic"] },
        { parts: ["sel"], text: ["sel-t"], annots: [{ kind: "size", target: "sel", axis: "h", label: height }] },
        { parts: ["sw"], text: ["sw-t"], annots: [{ kind: "center", target: "formrow", axis: "h" }] },
      ],
    },
  ];
}
