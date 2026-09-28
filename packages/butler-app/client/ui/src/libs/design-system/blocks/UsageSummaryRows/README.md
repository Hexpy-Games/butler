# UsageSummaryRows

## What is this component
A presenter for provider usage: quota windows as meters, token counts and a
USD cost as label/value rows, and loading, unavailable and stale states.

## When to use this component
Use it where a surface summarizes a model provider's usage: the composer
context popover (subscription quota or API tokens and cost) or a usage panel.

## Where to use this component
Popovers, inspector panels and settings summaries. At 280px it fits the
composer popover (`PopoverContent width="narrow"`).

## Why to use this component
It keeps quota, token and cost presentation identical everywhere and owns the
number formats and motion (compact tokens, USD rules, `AnimatedNumber`).

## How to use this component
Pass numbers and short copy; the block formats them.

```tsx
<UsageSummaryRows
  unavailableLabel={copy.unavailable}
  remainingLabel={copy.left}
  quotaWindows={[{ id: "5h", label: copy.fiveHour, remainingPercent: 82, caption: copy.resets }]}
/>
<UsageSummaryRows
  unavailableLabel={copy.unavailable}
  estimateLabel={copy.est}
  tokens={[{ id: "input", label: copy.input, value: 48200 }]}
  cost={{ label: copy.cost, usd: 0.0842, estimated: true }}
/>
```

- `state`: `ready` (default), `loading` (skeleton rows named by
  `loadingLabel`), `unavailable` (only `unavailableLabel`, one muted line).
- `updatedLabel` marks the data stale (`data-stale`) and adds one caption.
- `formatUsageTokens(value, locale)` (en `12.3k`, ko `1.2만`) and
  `formatUsageUsd(value)` (`$0.42`, `$0.0042`, `<$0.0001`) are exported for
  related text such as the context line.

## Who can use this component
Product containers that already selected the provider, quota and token data.

## Best practice
Pick the section per auth mode in the container: quota windows for a
subscription, tokens and cost for an API key, nothing for local models.

## Wrong use cases
Do not add explanations for missing data; use the unavailable state. Do not
separate sections with divider lines; the block spaces them.

## Tags
usage, quota, tokens, cost, subscription, api

## Motion
Token counts, cost and the quota percent count to new values with
`AnimatedNumber` (`--motion-deliberate`); meters fill with the
`ProgressMeter` transform. Reduced motion swaps values instantly.
