import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../DropdownMenu";
import { Brush, Eraser } from "../Icons";
import { BottomSheet, BottomSheetItem } from "./BottomSheet";

// #region recipe: Tool chooser on a phone
function ToolChooser() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" text="Tool" onClick={() => setOpen(true)} />
      <BottomSheet open={open} onOpenChange={setOpen} title="Tool" closeLabel="Close">
        <BottomSheetItem selected icon={<Brush size="md" />}>Brush</BottomSheetItem>
        <BottomSheetItem icon={<Eraser size="md" />}>Eraser</BottomSheetItem>
      </BottomSheet>
    </>
  );
}
// #endregion

// #region recipe: A menu that becomes a sheet on phones
function ResponsiveMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" text="More" /></DropdownMenuTrigger>
      <DropdownMenuContent presentation="auto">
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem>Download</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A modal glass sheet along the bottom edge for choices and short tasks on phones; menus, popovers and selects open as one through presentation.",
  whenToUse: [
    "A choice list or a short task opened on a phone-width screen",
    "A DropdownMenu, Popover or Select that should be thumb-reachable below 768px (presentation=\"auto\")",
  ],
  whenNotToUse: [
    { when: "A desktop chooser anchored to its control", use: "Popover" },
    { when: "A form or a decision that needs the whole screen's attention", use: "Dialog" },
    { when: "A suggestion list under its field (width=\"anchor\")", use: "Popover" },
  ],
  recipes: [
    { name: "Tool chooser on a phone", description: "Direct use: title, closeLabel and BottomSheetItem rows.", render: () => <ToolChooser /> },
    { name: "A menu that becomes a sheet on phones", description: "presentation=\"auto\" keeps the menu's keyboard and items; only its placement changes.", render: () => <ResponsiveMenu /> },
  ],
  doDont: [
    {
      do: { caption: "Keep the existing menu and pass presentation=\"auto\"; items, keys and dismissal stay the same.", render: () => <ResponsiveMenu /> },
      dont: { caption: "Do not build a second phone-only menu in a Dialog.", render: () => (
        <Dialog>
          <DialogTrigger asChild><Button variant="outline" text="More" /></DialogTrigger>
          <DialogContent closeLabel="Close"><DialogTitle>More</DialogTitle></DialogContent>
        </Dialog>
      ) },
    },
  ],
  content: [
    "title names the choice in one or two words (Tool, Model); closeLabel names the grabber (Close / 닫기).",
    "Rows are a few words; a check marks the current choice, so no row says “selected”.",
    "The app-wide default presentation is \"popover\" (DEFAULT_OVERLAY_PRESENTATION); a screen that wants sheets on phones passes \"auto\".",
  ],
  accessibility: [
    "A modal dialog: focus moves in, Tab wraps inside and focus returns to the opener. Esc, a tap on the backdrop, a downward drag or flick and the grabber close it.",
    "Presented menus and selects keep Radix's arrow keys, typeahead and Escape.",
    "Reduced motion keeps only the fade; the sheet does not slide.",
    "Rows are 44px tall; the body's inline padding leaves room for focus rings.",
  ],
  tokens: ["--tinted-glass-bg", "--radius-popover", "--dialog-overlay-bg", "--z-popover", "--motion-deliberate", "--motion-ease-settle", "--motion-exit-slow", "--motion-ease-accelerate", "--safe-area-bottom", "--focus-ring-room", "--radius-pill"],
};
