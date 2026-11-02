# DialogForm

## What is this component
A form shell for dialog content.

## When to use this component
Use it for modal create, edit, rename, and confirmation forms.

## Where to use this component
Use it inside `DialogContent`.

## Why to use this component
It standardizes dialog header, form body, and footer layout.

## How to use this component
Pass title, optional description, children, footer, and submit handler.

## Who can use this component
Dialog containers and management forms.

## Best practice
Keep validation and persistence outside the block.

Inside a `DialogContent` with a close button, the title keeps the button's
room free on its inline end (`--dialog-title-close-room`), so a long title
wraps before the close button instead of running under it. Short titles and
page forms (no dialog) render unchanged. Do not add padding or manual line
breaks to a title for the close button.

## Wrong use cases
Do not use it for non-modal page forms. Use `FormSection` and `SettingsField`.

## Tags
dialog, form, modal, shell
