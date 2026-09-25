# Toast

## What is this component

Butler's transient notification: sonner's `Toaster` configured once by the
app (`AppToaster`, top center, close button, 8px gap) with the DS class names
from `toastClassNames` (success tone uses the success color tokens).

## When to use this component

Use a toast for short, non-blocking results of an action the user just took
(saved, queued, archived with undo) or a background failure the user should
know about. Raise it through the app notification helpers (`notifyStatus`,
`notifyLoading`), never by mounting another `Toaster`. Use `Notice` for a
persistent inline problem and `Dialog` when the user must decide.
