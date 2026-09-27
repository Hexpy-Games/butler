# RollingStatusLine

## What is this component

A fixed one-line slot (body line height) for the current turn status. Content
never changes the slot height; a long paragraph is clipped with an ellipsis and
the full text belongs in `title`.

## When to use this component

Use it for the live status under a running assistant turn, usually wrapping a
spinner or mark plus one line of text, and `RollingSwap` when the line changes.
Set `aria-live="polite"` so the status is announced without interrupting.
Do not put multi-line or interactive content inside it.
