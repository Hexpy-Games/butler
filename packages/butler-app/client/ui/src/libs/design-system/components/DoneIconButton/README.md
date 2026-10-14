# DoneIconButton

## What is this component
DoneIconButton is an icon-only action that confirms success on the button
itself. It runs `onAction`, and once its result (or promise) resolves it
morphs the icon into a check for 1.5s (crossfade with a slight scale, the
check drawn by SuccessCheck), switches its tooltip/accessible name to
`doneLabel` and announces it in a polite `role="status"` live region.
CopyButton is DoneIconButton with the copy action, so copy and save share one
morph.

## Props

| Prop | Values |
| --- | --- |
| `label` | tooltip and accessible name before the action |
| `doneLabel` | label (and announcement) after the action succeeds |
| `icon` | the action icon at `size="sm"` |
| `onAction` | `(event) => unknown`; the check waits for a returned promise |
| `onError` | called when `onAction` throws or rejects; no check shows |
| `done` | parent-driven done state |
| `announce` | `false` when the action announces its own result (a toast) |
| `aria-label` | accessible name when it differs from `label` |

## How to use this component

```tsx
import { DoneIconButton, Library } from "@/butler-ds";

<DoneIconButton icon={<Library size="sm" />} label={copy.saveToLibrary} doneLabel={copy.savedToLibrary}
  onAction={() => saveItem(item)} onError={notifyFailure} announce={false} />
```

## Best practice
- The check shows only after the action succeeded; a rejection shows none.
- Clicks while the action runs are ignored, so a double click saves once.
- Reduced motion keeps the crossfade; the scale token is 1.

## Wrong use cases
- Do not swap an icon and `Check` by hand in product code.
- Do not use it for copying text; use `CopyButton`.
- Do not use it for toggles or navigation; use `IconButton`.

## Tags
action, save, library, confirm, check, feedback, motion, aria-live
