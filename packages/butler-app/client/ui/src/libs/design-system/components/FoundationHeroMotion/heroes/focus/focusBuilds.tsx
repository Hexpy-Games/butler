import { Button } from "../../../Button";
import { Command, FileText } from "../../../Icons";
import { Input } from "../../../Input";
import { Label } from "../../../Label";
import { Switch } from "../../../Switch";
import { Tabs, TabsList, TabsTrigger } from "../../../Tabs";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { Annot, BuildSpec } from "../shared/types";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/** The ring on a control, badged with the token it is drawn from. */
const ring = (target: string): Annot => ({ kind: "ring", target, label: ["--focus-ring", "--focus-ring · 2px"] });

/**
 * Components by topic (button, field, switch, tabs): each drawn as its
 * blueprint, filled, then receiving the one focus ring with its badge.
 */
export function focusBuilds(copy: FocusCopy): BuildSpec[] {
  const { topics } = copy;
  return [
    {
      id: "button",
      render: <Topic id="t1" title={topics.button}><span className={s.buildRow}><Mark n="b" part sketch><Button text={<R name="b-t">{copy.continue}</R>} /></Mark></span></Topic>,
      steps: [{ text: ["t1-topic"] }, { parts: ["b"], text: ["b-t"] }, { annots: [ring("b")] }],
    },
    {
      id: "field",
      render: <Topic id="t2" title={topics.field}><Mark block n="in" sketch sweep><Input aria-label={copy.email} readOnly value={copy.email} /></Mark></Topic>,
      steps: [{ text: ["t2-topic"] }, { parts: ["in"] }, { annots: [ring("in")] }],
    },
    {
      id: "toggle",
      render: (
        <Topic id="t3" title={topics.toggle}>
          <Label><Mark n="sw" part sketch><Switch aria-label={copy.sidebar} checked onCheckedChange={() => undefined} /></Mark><R name="sw-t">{copy.sidebar}</R></Label>
        </Topic>
      ),
      steps: [{ text: ["t3-topic"] }, { parts: ["sw"], text: ["sw-t"] }, { annots: [ring("sw")] }],
    },
    {
      id: "tabs",
      render: (
        <Topic id="t4" title={topics.tabs}>
          <Mark block n="tabs" sketch>
            <Tabs defaultValue="summary">
              <TabsList aria-label={copy.summary}>
                <TabsTrigger value="summary"><Command size="md" /><R name="tb-0">{copy.summary}</R></TabsTrigger>
                <TabsTrigger value="files"><FileText size="md" /><R name="tb-1">{copy.files}</R></TabsTrigger>
              </TabsList>
            </Tabs>
          </Mark>
        </Topic>
      ),
      marks: { active: '[data-state="active"]' },
      steps: [{ text: ["t4-topic"] }, { text: ["tb-0", "tb-1"] }, { annots: [ring("active")] }],
    },
  ];
}
