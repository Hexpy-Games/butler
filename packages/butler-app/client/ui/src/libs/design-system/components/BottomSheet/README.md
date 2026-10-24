# BottomSheet

## What is this component
A modal glass sheet along the bottom edge of the screen, with a grabber, for
choices and short tasks on phones. The same sheet is how `DropdownMenuContent`,
`PopoverContent` and `SelectContent` open when their `presentation` resolves to
a sheet.

## When to use this component
- A choice list or short task on a phone-width screen (direct use).
- A menu, popover or select that should be thumb-reachable on phones: pass
  `presentation="auto"` to its content.

## How to use this component
```tsx
import { BottomSheet, BottomSheetItem } from "@/butler-ds";

<BottomSheet open={open} onOpenChange={setOpen} title={t("tool")} closeLabel={t("close")}>
  <BottomSheetItem icon={<Brush size="md" />} selected={tool === "brush"} onSelect={() => setTool("brush")}>{t("brush")}</BottomSheetItem>
  <BottomSheetItem icon={<Eraser size="md" />} selected={tool === "eraser"} onSelect={() => setTool("eraser")}>{t("eraser")}</BottomSheetItem>
</BottomSheet>

<DropdownMenuContent presentation="auto">…</DropdownMenuContent>
```

- `expandable`: rests at half height; dragging the grabber up (or a flick)
  expands it below the titlebar, dragging down collapses it.
- `BottomSheetItem` closes the sheet after `onSelect` unless the handler calls
  `event.preventDefault()`.

## Presentation
`presentation` on `DropdownMenuContent`, `PopoverContent` and `SelectContent`:
- `popover`: anchored to the trigger (Popover keeps its 640px attached sheet).
- `sheet`: always a BottomSheet.
- `auto`: a BottomSheet below 768px, anchored above.

The default is `DEFAULT_OVERLAY_PRESENTATION` in `lib/presentation.ts`, today
`popover`. Changing that one constant to `auto` makes every menu, popover and
select a sheet on phones; `PopoverContent width="anchor"` (suggestion lists)
stays attached unless it asks for a sheet. A presented sheet keeps Radix's
keyboard, typeahead, focus and dismissal; only its placement and chrome change
(`sheet-presentation.css` pins the popper wrapper and draws the backdrop).
Submenus still open beside their row; avoid them in sheet menus.

## Interaction
- Grabber: drag down past 30% of the height or flick down to dismiss; the
  exit continues from where the finger let go. Short drags spring back.
- Backdrop tap, Esc and (direct use) the grabber button close it.
- Focus moves into the sheet, Tab wraps inside it, and focus returns to the
  opener.
- The on-screen keyboard pushes the sheet up (`--sheet-keyboard-inset`, from
  the visual viewport, listened to only while open).

## Motion
Opens with a slide on `--motion-ease-settle` (a critically damped spring) over
`--motion-deliberate`, closes accelerating over `--motion-exit-slow`, the
backdrop fades. Reduced motion (the OS setting or the app's own) keeps only the fade.

## Responsive behavior
Full width along the bottom edge, clear of the bottom safe area, at most the
viewport below the titlebar. Rows are 44px.

## Wrong use cases
- Do not open a desktop chooser as a sheet; use `presentation="auto"`.
- Do not rebuild a menu inside a `Dialog` for phones.
- Do not put long forms in a sheet; use a Dialog or a page.

## Tags
overlay, sheet, mobile, menu, select, motion
