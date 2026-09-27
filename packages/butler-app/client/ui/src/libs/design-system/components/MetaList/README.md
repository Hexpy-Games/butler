# MetaList

## What is this component
MetaList renders a wrapping run of label/value metadata in caption type, for
example `Input 36,460  Cache 8,200  Output 4,420`. It is a description list
(`dl` with `dt`/`dd` pairs), so assistive technology reads each label with its
value.

## Props

| Prop | Values |
| --- | --- |
| `items` | `{ label?: ReactNode; value: ReactNode }[]`; omit `label` for a value-only entry such as a source name |

## How to use this component

```tsx
import { MetaList } from "@/butler-ds";

<MetaList items={[
  { label: copy.input, value: formatCount(bucket.promptTokens) },
  { label: copy.cache, value: formatCount(bucket.cachedTokens) },
]} />
```

## Best practice
- Labels are short terms without a leading `·` or trailing `:`; MetaList owns
  the space between label and value (`--space-xs`) and between pairs
  (`--space-md`), and wrapped lines sit `--space-xs` apart.
- Labels are tertiary, values secondary with tabular numerals.

## Wrong use cases
- Do not concatenate label and value copy in JSX (`{label}{value}`); the words
  run together.
- Do not use it for editable settings or two-column fact tables; use
  `SettingsField` or `KeyValueRow`.

## Tags
metadata, description list, caption, usage, numbers
