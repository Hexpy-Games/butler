import type { ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { BROWSER_DEMO_COPY } from "../BrowserPane/fixtures/copy";
import { DemoBand, type DemoBandKind } from "../BrowserPane/fixtures/DemoBand";
import fixtures from "../BrowserPane/fixtures/fixtures.module.css";

export const meta: ShowcaseMeta = {
  title: "PageBand",
  category: "Browser",
  tags: ["browser", "band", "page state", "agent", "approval", "picking", "pop-up", "take over"],
  status: "beta",
};

/** The band on the top edge of a card, as on a PageCard. */
function OnCard({ children, width }: { children: ReactNode; width?: number }) {
  return (
    <div className={fixtures.cardTop} style={{ width: width ?? "100%" }}>{children}</div>
  );
}

const TONES: Array<[DemoBandKind, string]> = [
  ["agent", "agent"], ["user", "user"], ["waiting", "waiting"], ["need-you", "warning"], ["pick", "pick"], ["popup", "info"],
];

export const stories: ShowcaseStory[] = [
  {
    name: "Every tone",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Stack gap="md">
        {TONES.map(([kind, tone]) => (
          <Stack gap="xs" key={kind}>
            <Typo.Caption tone="tertiary">{tone}</Typo.Caption>
            <OnCard><DemoBand kind={kind} copy={BROWSER_DEMO_COPY[locale]} /></OnCard>
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    // Acceptance: one line with two buttons at 736px; only the detail truncates.
    name: "At 736px: one line, two buttons",
    widths: ["app", "wide"],
    render: ({ locale }) => <OnCard width={736}><DemoBand kind="agent" copy={BROWSER_DEMO_COPY[locale]} /></OnCard>,
  },
  {
    name: "Narrow card: the hint drops, the detail truncates",
    render: ({ locale }) => (
      <Stack gap="sm">
        <OnCard width={480}><DemoBand kind="pick" copy={BROWSER_DEMO_COPY[locale]} /></OnCard>
        <OnCard width={420}><DemoBand kind="waiting" copy={BROWSER_DEMO_COPY[locale]} /></OnCard>
      </Stack>
    ),
  },
];
