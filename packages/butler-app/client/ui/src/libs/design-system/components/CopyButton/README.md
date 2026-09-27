# CopyButton

## What is this component
CopyButton is the icon-only copy action. It writes text to the clipboard,
morphs the copy icon into a check for 1.5s (crossfade with a slight scale),
switches its tooltip/accessible name to the copied label, and announces the
result through a polite `role="status"` live region.

## Props

| Prop | Values |
| --- | --- |
| `label` | tooltip and accessible name before copying |
| `copiedLabel` | label and announcement after copying |
| `text` | `string` or `() => string` to copy |
| `onCopy` / `copied` | parent-driven copy action and copied state (instead of `text`) |
| `onError` | clipboard failure callback |
| `aria-label` | accessible name when it differs from `label` |

## How to use this component

```tsx
import { CopyButton } from "@/butler-ds";

<CopyButton text={code} label={copy.copyCode} copiedLabel={copy.copied} onError={notify} />
```

## Best practice
- Every copy action (message actions, code block header, CopyTextButton) uses
  CopyButton so feedback and announcements stay identical.
- Reduced motion keeps the crossfade; the scale token is 1.

## Wrong use cases
- Do not swap `Copy`/`Check` icons by hand in product code.
- Do not use it for text buttons such as "Copy link"; use `Button`.

## Tags
action, copy, clipboard, feedback, motion, aria-live
