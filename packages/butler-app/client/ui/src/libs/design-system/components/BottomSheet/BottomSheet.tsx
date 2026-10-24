import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils";
import { adaptiveShellThemeClasses, type AdaptiveShellTheme } from "../../lib/theme";
import { tintedGlassSurfaceClassName } from "../TintedGlass";
import { CheckIcon } from "../Icons";
import { useKeyboardInset, useSheetDrag } from "./sheetBehavior";
import { loopSheetFocus } from "./sheetFocus";
import { useReducedMotion } from "../../lib/useReducedMotion";
import styles from "./BottomSheet.module.css";

const CloseSheet = React.createContext<() => void>(() => undefined);

type SheetHandleProps = {
  surfaceRef: React.RefObject<HTMLElement | null>;
  /** Without a label the grabber is decorative (menus close with Escape, the backdrop or a choice). */
  closeLabel?: string;
  onClose: () => void;
  expandable?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

/** Grabber row shared by BottomSheet and sheet presentations: drag to dismiss or change detent; the grabber button closes. */
export function SheetHandle({ surfaceRef, closeLabel, onClose, expandable = false, expanded = false, onExpandedChange }: SheetHandleProps) {
  const drag = useSheetDrag(surfaceRef, {
    expandable,
    expanded,
    onExpandedChange: onExpandedChange ?? (() => undefined),
    onDismiss: onClose,
  });
  return (
    <div className={styles.handle} data-slot="bottom-sheet-handle" {...drag}>
      {closeLabel
        ? <button aria-label={closeLabel} className={styles.grabber} type="button" onClick={onClose} />
        : <span aria-hidden="true" className={styles.grabber} />}
    </div>
  );
}

export type BottomSheetProps = DsBaseProps<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visible heading; also the dialog's accessible name. */
  title: string;
  /** Accessible name of the grabber, which closes the sheet. */
  closeLabel: string;
  /** Rests at half height and drags up to full height (long lists, forms). */
  expandable?: boolean;
  /** App theme for the portalled surface (it renders outside the themed shell). */
  theme?: AdaptiveShellTheme;
  children?: React.ReactNode;
}>;

/** A modal sheet along the bottom edge for choices and short tasks on phones. */
export function BottomSheet({ open, onOpenChange, title, closeLabel, expandable = false, theme, className, children }: BottomSheetProps) {
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  React.useEffect(() => {
    if (!open) return;
    setExpanded(false);
    surfaceRef.current?.style.removeProperty("--sheet-drag-y");
  }, [open]);
  useKeyboardInset(surfaceRef, open);
  const reduced = useReducedMotion();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn(styles.backdrop, theme && adaptiveShellThemeClasses(theme))} data-slot="bottom-sheet-backdrop" />
        <DialogPrimitive.Content
          ref={surfaceRef}
          aria-describedby={undefined}
          className={cn(tintedGlassSurfaceClassName, styles.surface, theme && adaptiveShellThemeClasses(theme), className)}
          data-expandable={expandable ? "" : undefined}
          data-expanded={expandable && expanded ? "" : undefined}
          data-glass="popover"
          data-radius="popover"
          data-reduced={reduced ? "" : undefined}
          data-sheet="dialog"
          data-slot="bottom-sheet"
          onKeyDown={loopSheetFocus}
        >
          <SheetHandle
            closeLabel={closeLabel}
            expandable={expandable}
            expanded={expanded}
            surfaceRef={surfaceRef}
            onClose={close}
            onExpandedChange={setExpanded}
          />
          <DialogPrimitive.Title className={styles.title}>{title}</DialogPrimitive.Title>
          <div className={styles.body} data-slot="bottom-sheet-body">
            <CloseSheet.Provider value={close}>{children}</CloseSheet.Provider>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export type BottomSheetItemProps = DsBaseProps<Omit<React.ComponentPropsWithoutRef<"button">, "onSelect"> & {
  ref?: React.Ref<HTMLButtonElement>;
  icon?: React.ReactNode;
  /** Shows a check; the row is announced as the current choice. */
  selected?: boolean;
  variant?: "default" | "destructive";
  /** Runs on activation, then the sheet closes unless the handler calls event.preventDefault(). */
  onSelect?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}>;

/** One touch-sized row in a BottomSheet. */
export function BottomSheetItem({ ref, icon, selected, variant = "default", onSelect, className, children, ...props }: BottomSheetItemProps) {
  const close = React.useContext(CloseSheet);
  return (
    <button
      ref={ref}
      aria-current={selected ? "true" : undefined}
      className={cn(styles.item, className)}
      data-slot="bottom-sheet-item"
      data-variant={variant}
      type="button"
      onClick={(event) => {
        onSelect?.(event);
        if (!event.defaultPrevented) close();
      }}
      {...props}
    >
      {icon ? <span aria-hidden="true" className={styles.itemIcon}>{icon}</span> : null}
      <span className={styles.itemLabel}>{children}</span>
      {selected ? <span aria-hidden="true" className={styles.itemCheck}><CheckIcon /></span> : null}
    </button>
  );
}
