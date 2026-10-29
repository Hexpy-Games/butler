# SettingsActionField

## What is this component
A settings row whose control is an action: label, a one-line description of
what the action does and what it changes, and the button under them.

## When to use this component
Use it for every settings action that is not itself a value: free up space,
reset, clear site data, export logs, run setup again, erase everything.

## Where to use this component
Inside a `SettingsSection` (any kind) or a `FormSection` card, next to the
fields of the same subject.

## Why to use this component
An action beside a section title, or a bare button row, does not say what it
does or what it costs. As a field, the action reads like every other setting:
same ramp, same 24px separation, and the consequence stated before the click.

## How to use this component
`label`, `description` and `action` are required. `action` is one `Button`
(a `ButtonContainer` only when two actions act on the same thing, View and
Clear). The caller keeps behavior: the confirm dialog of a destructive action,
the disabled state with its tooltip reason, the busy spinner.
`details` (optional) holds read-only facts the action works on, a
`SurfacePanel elevation="subtle"` facts card, between the description and the
button: details first, then the action, at the field's control gap (8px,
`--settings-field-control-gap`). The description still describes the button.
`afterControl` sits directly under the button (a progress line with a Cancel);
`meta` holds facts about what the action affects (sizes, counts, last change)
and comes last. `settingId`, `id` and `descriptionId` work as on
`SettingsField`. When `action` is the `Button` itself, the description id
joins its `aria-describedby`; a button wrapped in a `Tooltip` sets
`aria-describedby` to the `descriptionId` it passes.

```tsx
<SettingsActionField
  settingId="memory-reset-chat"
  label="Reset chat memory"
  description="Erases everything remembered from chats. This can't be undone."
  action={<Button variant="outline" size="sm" onClick={confirmReset}>Reset</Button>}
  meta={<MetaList items={facts} />}
/>

<SettingsActionField
  settingId="free-space"
  label="Storage"
  description="Deletes unused old copies. Memories stay."
  details={<SurfacePanel elevation="subtle"><MetaList items={storageFacts} /></SurfacePanel>}
  action={<Button variant="outline" size="sm" onClick={freeUpSpace}>Free up space</Button>}
/>
```

## Who can use this component
Settings pages and settings-like panels.

## Best practice
The description says what happens and, for destructive actions, that it
cannot be undone, in one short line. The button label is the verb ("Reset",
"Free up space"); the label names the subject ("Reset chat memory",
"Storage"). Destructive actions keep a confirm dialog that lists what is
removed and what stays.

## Wrong use cases
Do not put an action in a section header `actions` slot: header actions are
list toolbars (add, refresh, filter on a `kind="list"` section), and
`bun run lint:ds` rejects them elsewhere (`butler-ds/settings-field-grouping`).
Do not place a button beside a `ListRow` to make a settings action. Do not
stack a facts panel and a button in `action` by hand; use `details`. Do not
use it for a value (a switch, a select); use `SettingsField`.

## Tags
settings, action, reset, destructive, field
