# ActivityGlow

## What is this component

A halo and a status dot around an `IconButton`. It tells what Butler is doing
with the surface the button opens (the browser area) while that surface stays
closed. `IconButton` itself does not change.

| State | Default | Reduced motion |
| --- | --- | --- |
| `idle` | Nothing | Nothing |
| `busy` | A blurred conic ring of the Butler inks turns every 3.2s and breathes in opacity (0.28–0.7, 2.4s). Pair with `tone="riso"` (`activityGlowTone`) | The riso dot |
| `attention` | A soft amber halo that pulses twice on entry, then holds, plus an amber dot | The amber dot |
| `error` | A red dot | The red dot |

## When to use this component

The titlebar browser toggle while Butler browses in the background
(plan-background-browser-rail §3).

## Where to use this component

Titlebar trailing icons. It needs about 5px of free room around the button for
the halo.

## Why to use this component

The halo, the dot and their motion live in the DS on `--activity-glow-*` and
`--motion-*` tokens, honour reduced motion, and leave the frozen
`IconButton` primitive untouched.

## How to use this component

```tsx
<ActivityGlow state={state}>
  <IconButton label={label} tone={activityGlowTone(state, open)} pressed={open} onClick={toggle}>
    <Globe2 size="md" />
  </IconButton>
</ActivityGlow>
```

- `state`: `idle | busy | attention | error`. Pass `idle` while the browser
  area is open; the open toggle is `tone="butler"` with `pressed`.
- `activityGlowTone(state, open)`: the matching `IconButton` tone.
- `reducedMotion`: force reduced motion on or off (defaults to the OS setting,
  the app override and the DS Viewer scope).

## Who can use this component

The App's `BrowserToggle` container. It derives the state for the active
conversation and its child sessions.

## Best practice

- Derive the state by priority: needs you, then busy, then error, then idle.
- Build the label from butler-i18n `browser.glow.*`. Example: `브라우저 보기 · 버틀러가 사용 중`.
- Announce the change to needs-you once through `notifyStatus`.

## Wrong use cases

- Do not use it for counts. Use the `IconButton` `badge` for those.
- Do not put it on rows or cards.
- Do not stack two glows on one button.

## Tags

browser, toggle, titlebar, glow, halo, status, background, busy, attention
