import { useState } from "react";
import type { ShowcaseMeta, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { ColorSwatchInput } from "./ColorSwatchInput";

export const meta: ShowcaseMeta = {
  title: "ColorSwatchInput",
  category: "Input",
  tags: ["color", "theme", "swatch", "form"],
  status: "stable",
};

const labels = {
  "en-US": { accent: "Accent", surface: "Surface", disabled: "Locked by the theme" },
  "ko-KR": { accent: "강조색", surface: "표면색", disabled: "테마가 고정한 색" },
} as const;

function Swatch({ label, initial, disabled }: { label: string; initial: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <Stack align="row" gap="sm" cross="center">
      <ColorSwatchInput aria-label={label} value={value} disabled={disabled} onChange={(event) => setValue(event.target.value)} />
      <Stack gap="none">
        <Typo.Label>{label}</Typo.Label>
        <Typo.Caption>{value.toUpperCase()}</Typo.Caption>
      </Stack>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Theme colors",
    states: ["default", "focus"],
    render: ({ locale }) => (
      <Stack align="row" gap="xl" wrap>
        <Swatch label={labels[locale].accent} initial="#5b5bd6" />
        <Swatch label={labels[locale].surface} initial="#f2f3f4" />
      </Stack>
    ),
  },
  {
    name: "Disabled",
    states: ["disabled"],
    render: ({ locale }) => <Swatch label={labels[locale].disabled} initial="#1f2328" disabled />,
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "disabled"],
  render: (context) => (
    <ColorSwatchInput aria-label={labels[context.locale].accent} defaultValue="#007aff" disabled={context.state === "disabled"} />
  ),
};
