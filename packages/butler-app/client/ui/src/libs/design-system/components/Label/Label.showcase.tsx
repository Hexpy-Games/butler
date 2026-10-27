import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Field, FieldLabel } from "../Field";
import { Input } from "../Input";
import { Switch } from "../Switch";
import { Label } from "./Label";

export const meta: ShowcaseMeta = {
  title: "Label",
  category: "Input",
  tags: ["form", "accessibility", "label"],
  status: "stable",
};

const labels = {
  "en-US": { mode: "Developer mode", search: "Search the web", engine: "Search engine", value: "DuckDuckGo" },
  "ko-KR": { mode: "개발자 모드", search: "웹 검색 사용", engine: "검색 엔진", value: "DuckDuckGo" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // Product forms use FieldLabel (a Label inside Field); a bare Label names a lone control.
    name: "Above a switch (stacked switch field)",
    render: (context) => (
      <Field>
        <Label htmlFor="ds-label-developer-mode">{text(context).mode}</Label>
        <Switch id="ds-label-developer-mode" defaultChecked />
      </Field>
    ),
  },
  {
    name: "Inside Field (FieldLabel)",
    render: (context) => (
      <Field>
        <FieldLabel htmlFor="ds-label-engine">{text(context).engine}</FieldLabel>
        <Input id="ds-label-engine" defaultValue={text(context).value} />
      </Field>
    ),
  },
  {
    name: "Disabled control",
    states: ["disabled"],
    render: (context) => (
      <Field>
        <Label htmlFor="ds-label-search">{text(context).search}</Label>
        <Switch id="ds-label-search" disabled />
      </Field>
    ),
  },
];
