import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ProviderLogo } from "../ProviderLogo";
import { Stack } from "../Stack";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";

export const meta: ShowcaseMeta = {
  title: "Select",
  category: "Input",
  tags: ["form", "selection"],
  status: "stable",
};

const labels = {
  "en-US": { choose: "Choose", one: "One", two: "Two", local: "Local", worktree: "Worktree", provider: "Provider" },
  "ko-KR": { choose: "선택", one: "하나", two: "둘", local: "로컬", worktree: "워크트리", provider: "제공자" },
} as const;

function SelectExample({ locale, value }: ShowcaseRenderContext & { value?: string }) {
  const text = labels[locale];
  return (
    <Select defaultValue={value}>
      <SelectTrigger aria-label={value ? "Selected value" : "Placeholder select"}>
        <SelectValue placeholder={text.choose} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="one">{text.one}</SelectItem>
        <SelectItem value="two">{text.two}</SelectItem>
      </SelectContent>
    </Select>
  );
}

const PROVIDERS = [
  { value: "openai", label: "OpenAI", logo: "openai" },
  { value: "anthropic", label: "Anthropic", logo: "claude" },
  { value: "google", label: "Google", logo: "gemini" },
] as const;

function ProviderSelect({ locale }: ShowcaseRenderContext) {
  const selected = PROVIDERS[1];
  return (
    <Select defaultValue={selected.value}>
      <SelectTrigger aria-label={labels[locale].provider}>
        <SelectValue icon={<ProviderLogo name={selected.logo} />}>{selected.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PROVIDERS.map((provider) => (
          <SelectItem key={provider.value} value={provider.value} icon={<ProviderLogo name={provider.logo} />}>{provider.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Default",
    render: ({ locale }) => (
      <Stack align="row" gap="sm" wrap>
        <SelectExample locale={locale} value="one" />
        <SelectExample locale={locale} />
      </Stack>
    ),
  },
  {
    name: "Disabled",
    states: ["disabled"],
    render: ({ locale }) => (
      <Select disabled defaultValue="one">
        <SelectTrigger aria-label="Disabled select">
          <SelectValue placeholder={labels[locale].choose} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">{labels[locale].one}</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
  {
    // Settings > Models: each service keeps its logo in the list and the trigger.
    name: "With icons (service logos)",
    widths: ["375", "app"],
    render: (context) => <ProviderSelect {...context} />,
  },
  {
    name: "Disabled option",
    states: ["disabled"],
    render: ({ locale }) => (
      // Open it: the unavailable option keeps its place in the disabled tone
      // (--interactive-disabled-fg) and never takes the hover fill.
      <Select defaultValue="local">
        <SelectTrigger aria-label="Workspace">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local">{labels[locale].local}</SelectItem>
          <SelectItem value="worktree" disabled>{labels[locale].worktree}</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "disabled"],
  variants: ["value", "placeholder"],
  render: (context) => (
    <Select defaultValue={context.variant === "value" ? "one" : undefined} disabled={context.state === "disabled"}>
      <SelectTrigger aria-label={labels[context.locale].choose}><SelectValue placeholder={labels[context.locale].choose} /></SelectTrigger>
      <SelectContent><SelectItem value="one">{labels[context.locale].one}</SelectItem></SelectContent>
    </Select>
  ),
};
