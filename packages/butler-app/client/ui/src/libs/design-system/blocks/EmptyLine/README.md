# EmptyLine

## What is this block

EmptyLine is a Butler design-system block for empty state displays with icon, message, and optional action.

## When to use this block

Use EmptyLine for empty lists, no results states, cleared filters, or any situation where content is absent and users need guidance.

## Container vs Presenter

**EmptyLine is a presenter block.** It owns empty state layout. It must not import Butler domain logic or stores.

**Container responsibilities:** Domain components detect empty state, provide message from app copy, and supply action handlers.

## Similar blocks

- Use **Notice** for informational banners, not empty states
- Use simple Typo.Body when no icon or action needed
- Compose with SurfacePanel for elevated empty states

## Usage

```tsx
import { EmptyLine } from "@/butler-ds";

{sessions.length === 0 && (
  <EmptyLine
    icon={<Inbox />}
    message="No sessions yet"
    action={<Button onClick={createSession}>Create Session</Button>}
  />
)}
```

## Accessibility

- Semantic text hierarchy
- Icon is decorative
- Action is keyboard accessible

## Responsive behavior

- Centered layout
- Adapts to container width
- Mobile-friendly spacing

## Wrong use cases

- Do not use for error messages; use Notice with error tone
- Do not use for loading states
- Do not use when content is loading vs truly empty

## Tags

empty, state, placeholder, no-content
