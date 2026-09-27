import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { UsageSummaryRows } from "./UsageSummaryRows";

// #region recipe: Subscription quota
function SubscriptionQuota() {
  return (
    <UsageSummaryRows
      unavailableLabel="Usage unavailable"
      remainingLabel={(percent) => `${percent} left`}
      quotaWindows={[
        { id: "5h", label: "5-hour", remainingPercent: 82, caption: "Resets 14:00" },
        { id: "week", label: "Weekly", remainingPercent: 64 },
      ]}
    />
  );
}
// #endregion

// #region recipe: API tokens and cost
function ApiTokensAndCost() {
  return (
    <UsageSummaryRows
      unavailableLabel="Usage unavailable"
      estimateLabel="est."
      locale="en-US"
      tokens={[
        { id: "input", label: "Input", value: 48_200 },
        { id: "cached", label: "Cached", value: 31_900 },
        { id: "output", label: "Output", value: 3_420 },
      ]}
      cost={{ label: "Cost", usd: 0.0842, estimated: true }}
    />
  );
}
// #endregion

// #region recipe: Unavailable
function Unavailable() {
  return <UsageSummaryRows state="unavailable" unavailableLabel="Usage unavailable" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Provider usage in a popover or panel: quota windows as meters, token counts and a USD cost as rows, with loading, unavailable and stale states.",
  whenToUse: [
    "Show subscription quota left (5-hour, weekly) with the reset time",
    "Show a conversation's tokens and cost for an API-key model",
  ],
  whenNotToUse: [
    { when: "Context window fill in the composer toolbar", use: "ContextDonutButton" },
    { when: "A single known fraction with a label", use: "ProgressMeter" },
    { when: "Dashboard totals with trends", use: "MetricGrid" },
  ],
  recipes: [
    { name: "Subscription quota", description: "remainingLabel turns the rounded percent into the meter meta; caption holds the reset time.", render: () => <SubscriptionQuota /> },
    { name: "API tokens and cost", description: "Numbers stay numbers: the block formats compact tokens and USD and counts on change.", render: () => <ApiTokensAndCost /> },
    { name: "Unavailable", description: "One muted line when the provider reports nothing.", render: () => <Unavailable /> },
  ],
  doDont: [
    {
      do: { caption: "One muted line when usage is unknown.", render: () => <Unavailable /> },
      dont: {
        caption: "Explaining why usage is missing.",
        render: () => (
          <Stack gap="xs">
            <Typo.Caption>Usage is unavailable because this provider does not expose a quota endpoint. Check the provider console.</Typo.Caption>
          </Stack>
        ),
      },
    },
  ],
  content: [
    "Labels are one or two words (Input, Cached, 5-hour); no sentences.",
    "Cost is USD: $0.42, $0.0042 under one cent, — when unpriced; the estimate marker is one word (est. / 추정).",
    "Stale data keeps its rows and adds one caption (Updated 14:05 / 14:05 기준).",
  ],
  accessibility: [
    "Each quota meter is a progressbar named \"<window>: <N% left>\".",
    "Animated numbers are aria-hidden; screen readers read the final value.",
    "Loading exposes aria-busy with loadingLabel as its name.",
  ],
  tokens: ["--text-tertiary", "--space-md", "--space-xs", "--motion-deliberate"],
};
