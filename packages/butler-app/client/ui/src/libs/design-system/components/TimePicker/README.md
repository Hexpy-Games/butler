# TimePicker

## What is this component
A time-of-day field. The value is `"HH:MM"` in 24 hours. The field shows one
segment per part (hour, minute, and the day period in 12-hour locales) in the
Input/Select look, with a clock button that opens wheel columns in a Popover
(a sheet on phones).

## When to use this component
Use it for a daily time setting, such as a run time or a quiet-hours bound.

## Where to use this component
In a `SettingsField` control slot or a form, imported from `@/butler-ds`.

## Why to use this component
Typing digits is fast on a keyboard, wheels are fast on touch, and both
always produce a valid time. The locale decides 12/24 hours, segment order and
day-period words through `Intl`, so no copy is hand-written.

## How to use this component

```tsx
import { TimePicker } from "@/butler-ds";

<TimePicker id="run-time" value={time} onValueChange={save} locale={locale}
  aria-label={copy.time} aria-describedby={hintId} pickerLabel={copy.pickTime} />
```

- `value` / `onValueChange`: `"HH:MM"` (24 h). `onValueChange` fires only when the value changes.
- `locale`: BCP 47; defaults to the document language. `hourCycle` overrides the locale (`"h12"` / `"h23"`).
- `minuteStep`: the minute wheel's step (default 5). A typed off-step minute joins the list in order.
- `pickerLabel`: the clock button's name ("Choose time" / "시간 고르기").
- `defaultOpen`: starts open (docs and tests).

Keyboard: digits fill a segment (a second digit, or an impossible first digit,
completes it and moves on); ↑/↓ step and wrap per segment; ←/→ and Tab move;
Home/End set min/max; A/P or the period's first letter sets the period; Enter
or Alt+↓ opens the wheels. In a wheel: ↑/↓/Home/End pick, ←/→ change column,
Enter/Space or a tapped minute close and return focus to the hour; Escape
returns focus too, a tap outside leaves focus where it went. A swipe or wheel
scroll picks the row it settles on.

Every column keeps its value on the same centre row. The wheel sets
`scrollTop` from the row index (never from measured, transformed boxes), in a
layout effect and again on `document.fonts.ready`. Wheels hide their scrollbar
like the DS rails. Hover fills only under `(hover: hover)`; reduced motion
turns transitions off.

## Who can use this component
Product engineers, design-system maintainers and coding agents building Butler client UI.

## Best practice
- Pass the app locale, not a fixed one.
- Format a stored time for display with `Intl`, not by hand.
- Check it in WebKit and Chromium: the centre row and hidden scrollbars differ between engines.

## Wrong use cases
- Do not use it for durations or counts of minutes; use `Input`.
- Do not use it for a few fixed choices; use `Select`.
- Do not show a second, hand-formatted copy of the value next to it.

## Tags
form, time, settings, schedule
