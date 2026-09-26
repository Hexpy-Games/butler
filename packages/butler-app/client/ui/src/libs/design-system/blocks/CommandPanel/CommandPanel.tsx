import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
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
  placeholder,
  children,
  onQueryChange,
}: CommandPanelProps) {
  return (
    <SurfacePanel elevation="high" className={styles.panel}>
      <Stack gap="sm">
        <label className={styles.search}>
          <Search size="md" aria-hidden="true" />
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
  /** Keep the panel mounted and toggle this, so the palette can animate out. */
  open?: boolean;
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
  open = true,
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
  const listId = useId();
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, items.length - 1);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const activeId = activeIndex >= 0 ? optionId(activeIndex) : undefined;

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") onClose();
    if (event.key === "Enter") items[activeIndex]?.onSelect();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.max(0, Math.min(items.length - 1, activeIndex + step)));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        motion="palette"
        className={styles.palette}
        aria-label={label}
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <div className={styles.inputRow}>
          <Search size="lg" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setActive(0);
              onQueryChange(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
          />
          <IconButton label={closeLabel} onClick={onClose}>
            <X size="md" />
          </IconButton>
        </div>
        <div className={styles.results}>
          {feedback ? <div role="status" aria-live="polite">{feedback}</div> : null}
          <div role="listbox" id={listId} aria-label={label}>
            {items.map((item, index) => (
              <button
                key={item.id}
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                onClick={item.onSelect}
                onPointerMove={() => setActive(index)}
              >
                {item.icon}
                <span>{item.title}</span>
                {item.subtitle ? <small>{item.subtitle}</small> : null}
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
