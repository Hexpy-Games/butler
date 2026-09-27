# LoadingIndicator

## What is this component
LoadingIndicator is one icon slot for work that completes: `state="loading"` shows the `Spinner`, `state="done"` draws the ringed `SuccessCheck` at the same size.

## Props

| Prop | Values |
| --- | --- |
| `state` | `loading`, `done` |
| `size` | Pixel box size for both states, default 16 (use `ICON_SIZE`) |
| `label` | Accessible name while loading (`role="status"`) |
| `doneLabel` | Accessible name of the check |

## Behavior
The check draws in only when the indicator was `loading` earlier in its life; an indicator that mounts already `done` (history rows, reloads) shows the static check. The caller owns the state and how long `done` stays; failure and cancellation render their own icons.

## How to use this component

```tsx
import { ICON_SIZE, LoadingIndicator } from "@/butler-ds";

<LoadingIndicator state={running ? "loading" : "done"} size={ICON_SIZE.lg} />
```

## Where
Inspector progress (SummaryPanel) and todo progress rows use it for running -> complete; CopyButton uses the plain `SuccessCheck`.

## Wrong use cases
- Do not render a separate `CheckCircle2` after unmounting a `Spinner` for the same slot; the completion motion is lost.
- Do not hold a done state open to force the animation; the caller decides when done ends.

## Tags
loading, spinner, done, check, complete, motion
