# OptionMenu

## What Is This Component

OptionMenu is a compact flat menu block for chooser popovers. The `title`
labels the menu for accessibility, but it is not rendered as a visible heading
by default. Use `OptionMenuSection` when a chooser needs real visible groups,
such as Model and Reasoning inside the model selector.

## When To Use This Component

Use it when a popover needs a vertical list of selectable options, such as
permission mode, model selection, or reasoning effort.

## Where To Use This Component

Use inside `PopoverContent`, `DropdownMenu`-like custom surfaces, or a DS
fixture when options need richer two-part labels than a native select.

## Why To Use This Component

It prevents ad hoc Button-based menus from inheriting button typography,
padding, or color rules. Menu body text stays regular weight and theme tokens
are applied consistently.

## How To Use This Component

Map domain options in a product container, then render `OptionMenuItem` with
neutral `label`, `description`, `icon`, `selected`, and optional `tone`.
Wrap related groups in `OptionMenuSection` when the section title changes the
meaning of the following items.
Use `descriptionPlacement="block"` when descriptions are explanatory sentence
copy, such as permission help text. Keep the default inline placement for short
metadata such as provider and context window.

## Who Can Use This Component

Any Butler UI agent or developer building compact option popovers.

## Best Practice

Keep labels short. Use descriptions as secondary metadata only when they add
unique information. Do not repeat the section name as every item's description.
Section titles must share the same horizontal inset as items and must not
introduce nested indentation.
Explanatory descriptions should sit below the label so they do not stretch the
popover horizontally.

## Wrong Use Cases

Do not use OptionMenu for long forms; use FormSection and SettingsField. Do not
use it for browser-native controls; use NativeSelect or Select.

## Tags

menu, popover, composer, options, selection
