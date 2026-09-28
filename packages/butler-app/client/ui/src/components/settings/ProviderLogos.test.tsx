/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSection } from "@/butler-ds";
import { FIRST_RUN_TEST_MODEL } from "@/app/fixtures.ts";
import type { AppModelSummary } from "@/app/types.ts";
import { BackupModelCards } from "./BackupModelCards";
import { ProviderMark } from "./ProviderMark";
import { RegisteredModelRow } from "./RegisteredModelRow";
import { SettingsSelect } from "./SettingsSelect";

const claude: AppModelSummary = {
  ...FIRST_RUN_TEST_MODEL, provider_id: "anthropic", provider_label: "Anthropic", model_id: "claude-sonnet-5",
  model_ref: "anthropic/claude-sonnet-5", display_name: "Claude Sonnet 5", registered: true,
};

function doc(markup: string) {
  return new JSDOM(markup).window.document;
}

test("provider marks use the DS logo, the local server's platform logo, or a neutral server icon", () => {
  expect(doc(renderToStaticMarkup(<ProviderMark providerId="anthropic" />)).querySelector('[data-slot="provider-logo"]')?.getAttribute("data-name")).toBe("claude");
  expect(doc(renderToStaticMarkup(<ProviderMark providerId="local" platform="ollama" />)).querySelector('[data-slot="provider-logo"]')?.getAttribute("data-name")).toBe("ollama");
  const custom = doc(renderToStaticMarkup(<ProviderMark providerId="local" platform="custom" />));
  expect(custom.querySelector('[data-slot="provider-logo"]')).toBeNull();
  expect(custom.querySelector("svg")).not.toBeNull();
});

test("a registered model row leads with its provider logo", () => {
  const row = doc(renderToStaticMarkup(<RegisteredModelRow model={claude} busy={false} onEdit={() => undefined} onDelete={() => undefined} />));
  const tile = row.querySelector('[data-slot="icon-tile"]');
  expect(tile?.querySelector('[data-slot="provider-logo"]')?.getAttribute("data-name")).toBe("claude");
  expect(row.querySelector("h3")?.textContent).toBe("Anthropic / Claude Sonnet 5");
});

test("a settings select shows the chosen option's logo in the trigger", () => {
  const field = doc(renderToStaticMarkup(
    <SettingsSection id="providers" kind="form">
      <SettingsSelect
        label="Provider"
        value="anthropic"
        onChange={() => undefined}
        options={[
          { value: "openai", label: "OpenAI", icon: <ProviderMark providerId="openai" /> },
          { value: "anthropic", label: "Anthropic", icon: <ProviderMark providerId="anthropic" /> },
        ]}
      />
    </SettingsSection>,
  ));
  const icon = field.querySelector('[data-slot="select-trigger"] [data-slot="select-value-icon"]');
  expect(icon?.querySelector('[data-slot="provider-logo"]')?.getAttribute("data-name")).toBe("claude");
});

test("backup model cards lead with the provider logo", () => {
  const cards = doc(renderToStaticMarkup(
    <BackupModelCards models={[claude]} fallback={{ enabled: true, models: [claude.model_ref] }} saving={false} onUpdate={() => undefined} />,
  ));
  expect(cards.querySelector('[data-slot="provider-logo"]')?.getAttribute("data-name")).toBe("claude");
});
