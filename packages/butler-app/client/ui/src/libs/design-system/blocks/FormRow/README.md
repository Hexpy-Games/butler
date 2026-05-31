# FormRow

## What is this block

FormRow is a Butler design-system block for form fields with label, input, help text, and error message layout.

## When to use this block

Use FormRow for settings forms, dialogs with inputs, configuration panels, or any form field that needs label + control + help/error pattern.

## Container vs Presenter

**FormRow is a presenter block.** It owns field layout and error display. It must not import Butler validation logic or domain state.

**Container responsibilities:** Domain components provide field values, validation errors, onChange handlers, and app copy for labels/help text.

## Similar blocks

- Use **Field** primitive when you need shadcn form integration
- Use **ControlField** (if created) for more complex control patterns
- Use simple Stack when you don't need form semantics

## Usage

```tsx
import { FormRow } from "@/butler-ds";

<FormRow
  label="API Key"
  help="Find this in your settings"
  error={errors.apiKey}
  htmlFor="api-key"
>
  <Input id="api-key" value={apiKey} onChange={setApiKey} />
</FormRow>
```

## Accessibility

- Label is properly associated via htmlFor
- Error messages are announced to screen readers
- Help text provides additional context

## Responsive behavior

- Stack layout adapts to width
- Text wraps appropriately
- Mobile-friendly spacing

## Wrong use cases

- Do not use for non-form content
- Do not use when Field primitive provides needed behavior
- Do not nest multiple inputs in one FormRow

## Tags

form, field, input, validation, label
