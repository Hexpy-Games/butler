# Notice

## What is this block

Notice is a Butler design-system block for alert/notice banners with info, warning, error, or success tones.

## When to use this block

Use Notice for inline feedback, validation messages, system alerts, or contextual notifications within a flow.

## Container vs Presenter

**Notice is a presenter block.** It owns notice layout and tone styling. It must not import Butler notification logic or stores.

**Container responsibilities:** Domain components detect conditions requiring notice, choose appropriate tone, provide message from app copy, and supply action handlers.

## Similar blocks

- Use **EmptyLine** for empty states, not alerts
- Use **Typo.Caption** for simple help text
- Use **Dialog** for critical alerts requiring focus

## Usage

```tsx
import { Notice } from "@/butler-ds";

{error && (
  <Notice
    tone="error"
    icon={<XCircle />}
    message="Failed to save changes"
    action={<Button onClick={retry}>Retry</Button>}
  />
)}
```

## Accessibility

- Color is supplemented by icon
- Text provides context
- Action is keyboard accessible
- ARIA live region may be needed in container

## Responsive behavior

- Full-width by default
- Icon and action remain visible
- Message wraps if needed

## Wrong use cases

- Do not use for empty states; use EmptyLine
- Do not use for critical blocking errors; use Dialog
- Do not use for toast notifications; use AppToaster

## Tags

notice, alert, banner, feedback, validation
