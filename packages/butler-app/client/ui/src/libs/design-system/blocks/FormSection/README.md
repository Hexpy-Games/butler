# FormSection

## What is this block

FormSection is a Butler design-system block for grouping related form fields under a titled section.

## When to use this block

Use FormSection in settings panels, configuration dialogs, or multi-section forms where fields need logical grouping.

Use it as the bordered top-level card for a settings group. Repeated editable
items inside it should be separate bordered rows or panels, not loose text.

## Container vs Presenter

**FormSection is a presenter block.** It owns section layout and title rendering. It must not import Butler domain logic or form state.

**Container responsibilities:** Domain components provide section title/description from app copy and map form fields.

## Similar blocks

- Use **NavSection** for navigation grouping, not forms
- Use **Section** primitive for general content sections
- Use **PanelHeader** + Stack for custom form layouts

## Usage

```tsx
import { FormSection, FormRow } from "@/butler-ds";

<FormSection title="Appearance" description="Customize your theme">
  <FormRow label="Theme"><Select>...</Select></FormRow>
  <FormRow label="Density"><Select>...</Select></FormRow>
</FormSection>
```

## Accessibility

- Uses semantic section element
- Title uses PanelTitle for hierarchy
- Description provides context

## Responsive behavior

- Full-width layout
- Fields stack vertically
- Mobile-friendly spacing

## Wrong use cases

- Do not use for navigation sections
- Do not use for non-form content grouping
- Do not use `Section` when the surface needs the settings card border
- Do not nest FormSections for repeated editable items; use a repeated row or panel

## Tags

form, section, grouping, settings
