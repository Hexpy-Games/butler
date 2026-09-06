import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Search } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { X } from "../../components/Icons";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { SurfacePanel } from "../SurfacePanel";
import { Dialog, DialogContent, DialogTitle } from "../../components/Dialog";
import styles from "./CommandPanel.module.css";

export interface CommandPanelProps {
  query: string;
  placeholder?: string;
  children: ReactNode;
  onQueryChange?: (query: string) => void;
}

export function CommandPanel({
  query,
  placeholder = "Search commands",
  children,
  onQueryChange,
}: CommandPanelProps) {
  return (
    <SurfacePanel elevation="high" className={styles.panel}>
      <Stack gap="sm">
        <label className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <Input
            value={query}
            placeholder={placeholder}
            onChange={(event) => onQueryChange?.(event.target.value)}
          />
        </label>
        <div className={styles.results}>{children}</div>
      </Stack>
    </SurfacePanel>
  );
}

export interface CommandPaletteItem {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
}

export interface CommandPalettePanelProps {
  label: string;
  query: string;
  placeholder: string;
  closeLabel: string;
  items: CommandPaletteItem[];
  feedback?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  onClose: () => void;
  onQueryChange: (query: string) => void;
}

export function CommandPalettePanel({
  label,
  query,
  placeholder,
  closeLabel,
  items,
  feedback,
  inputRef,
  onClose,
  onQueryChange,
}: CommandPalettePanelProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") onClose();
    if (event.key === "Enter") items[0]?.onSelect();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={styles.palette}
        aria-label={label}
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <div className={styles.inputRow}>
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
          />
          <IconButton label={closeLabel} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className={styles.results}>
          {feedback ? <div role="status" aria-live="polite">{feedback}</div> : null}
          {items.map((item) => (
            <button key={item.id} type="button" onClick={item.onSelect}>
              {item.icon}
              <span>{item.title}</span>
              {item.subtitle ? <small>{item.subtitle}</small> : null}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
