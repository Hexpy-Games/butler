# FilteredSelectPopover

## What Is This Component

FilteredSelectPopover is a chooser surface for option sets that can grow over
time. It combines search, filter chips, grouped results, and a compact footer
choice area.

## When To Use This Component

Use it when a popover list can become too long to scan as one flat menu, such as
model selection across providers with a separate reasoning selector.

## Where To Use This Component

Use inside `PopoverContent` or another bounded popover surface. Product code
should pass domain-neutral groups, filters, and footer options.

## Why To Use This Component

It prevents oversized chooser popovers by separating filtering controls, a
scrollable result region, and secondary choices. It also keeps row typography,
hover states, and icon alignment consistent with Butler menus.

## How To Use This Component

Keep filtering state in the product container. Pass `searchValue`, filter
options, grouped result items, and footer options into this block. The block
does not import stores, domain models, or app copy.

## Who Can Use This Component

Any Butler UI agent or developer building a searchable chooser popover.

## Best Practice

Group long results by a meaningful label. Keep footer options short and chip
like. Icons align to the first text row, so two-line items stay visually stable.
Search inputs should expose a clear button when populated, and filter chips
should have enough breathing room to read as a separate control row.
The result region should keep a stable fixed height around 200px and scroll
internally, including when search has no matches.

## Wrong Use Cases

Do not use it for simple three-item menus; use OptionMenu. Do not put forms or
multi-step settings flows here; use FormSection and SettingsField.

## Tags

popover, filter, search, model, select, chooser, menu
