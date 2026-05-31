# PanelHeader

## What is this block

PanelHeader is a Butler design-system block for panel titles with optional description and actions.

## When to use this block

Use PanelHeader at the top of inspector panels, settings sections, dashboard cards, or any panel-like surface that needs a title.

## Container vs Presenter

**PanelHeader is a presenter block.** It owns header layout and title rendering. It must not import Butler domain data or stores.

**Container responsibilities:** Domain components provide title/description from app copy and action button handlers.

## Similar blocks

- Use **FormSection** for form-specific sections
- Use **Section** primitive for simpler content sections
- Use **Typo.PanelTitle** alone when no description or actions needed

## Usage

```tsx
import { PanelHeader } from "@/butler-ds";

<PanelHeader
  title="Artifacts"
  description="Generated files and outputs"
  actions={<Button>View All</Button>}
/>
```

## Accessibility

- Uses semantic heading via PanelTitle
- Description provides additional context
- Actions are keyboard accessible

## Responsive behavior

- Title and actions layout adapts to width
- Text truncates if needed
- Mobile-friendly spacing

## Wrong use cases

- Do not use for page-level headings; use H1-H6
- Do not use for navigation sections; use NavSection
- Do not use when simple Typo.PanelTitle suffices

## Tags

panel, header, title, actions
