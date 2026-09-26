import type { ShowcaseGuidance } from "../../showcase";
import { DialogForm } from "../../blocks/DialogForm";
import { SettingsField } from "../../blocks/SettingsField";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { Input } from "../Input";
import { Popover, PopoverContent, PopoverTrigger } from "../Popover";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./Dialog";

// #region recipe: Rename dialog
function RenameDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" text="Rename" /></DialogTrigger>
      <DialogContent closeLabel="Close">
        <DialogHeader><DialogTitle>Rename conversation</DialogTitle></DialogHeader>
        <SettingsField id="rename" label="Name" control={<Input id="rename" defaultValue="Token page review" />} />
        <DialogFooter>
          <ButtonContainer size="default" justify="end">
            <DialogClose asChild><Button variant="outline" text="Cancel" /></DialogClose>
            <DialogClose asChild><Button text="Save" /></DialogClose>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A modal glass surface for a focused task that must finish or be dismissed before going on.",
  whenToUse: ["Rename, create or confirm something destructive", "Read a document on top of the current screen"],
  whenNotToUse: [
    { when: "A small choice anchored to a control", use: "Popover" },
    { when: "A list of actions for an item", use: "DropdownMenu" },
    { when: "Global search and commands", use: "CommandPalettePanel" },
    { when: "A notification that needs no decision", use: "Toaster" },
  ],
  recipes: [{ name: "Rename dialog", description: "Header, one field and footer actions; DialogClose wraps cancel and submit.", render: () => <RenameDialog /> }],
  doDont: [
    {
      do: { caption: "Use a dialog for a task with a clear end (save or cancel).", render: () => <RenameDialog /> },
      dont: {
        caption: "A popover for a multi-step form loses focus management and a backdrop.",
        render: () => (
          <Popover>
            <PopoverTrigger asChild><Button variant="outline" text="Rename" /></PopoverTrigger>
            <PopoverContent><DialogForm title="Rename">{null}</DialogForm></PopoverContent>
          </Popover>
        ),
      },
    },
  ],
  content: ["Title states the task (Rename conversation); buttons repeat the verb (Save, Archive)."],
  accessibility: [
    "Focus is trapped and returns to the trigger; Escape closes; pass closeLabel from app copy.",
    "Every dialog has a DialogTitle (sr-only when DialogForm shows the visible title).",
  ],
  tokens: ["--dialog-overlay-bg", "--tinted-glass-bg", "--z-dialog", "--motion-fast", "--motion-scale-dialog"],
  internalExports: {
    DialogPortal: "Rendered by DialogContent; exported for shells that need the portal alone.",
    DialogOverlay: "Rendered by DialogContent (backdrop fade); exported for custom shells.",
  },
};
