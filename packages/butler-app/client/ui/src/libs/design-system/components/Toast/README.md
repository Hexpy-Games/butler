# Toast

## What is this component

Butler's transient notification: the DS `Toaster` wraps sonner once (top
center, close button, 8px gap) and restyles every toast with DS tokens in
both themes: `--popover` surface with the composer glass filter, `--line`
border, `--shadow-card`, `--radius-panel`, `--text-primary` /
`--text-secondary`, and success, warning and error tones from the
`--color-*` tokens. The app mounts it once (`AppToaster`, offset by the
titlebar safe area).

## Motion
Toasts drop in by `--motion-distance-lg` and fade on `--motion-base`
(`--motion-ease-enter`) and leave on `--motion-exit-base`
(`--motion-ease-exit`); only transform and opacity move. Reduced motion
fades (sonner would otherwise switch every transition off).

## When to use this component

Use a toast for short, non-blocking results of an action the user just took
(saved, queued, archived with undo) or a background failure the user should
know about. Raise it through the app notification helpers (`notifyStatus`,
`notifyLoading`), never by mounting another `Toaster`. Use `Notice` for a
persistent inline problem and `Dialog` when the user must decide.
