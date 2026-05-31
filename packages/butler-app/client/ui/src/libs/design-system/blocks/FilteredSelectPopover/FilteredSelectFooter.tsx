import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import type { FilteredSelectFooterOption } from "./FilteredSelectPopover";
import styles from "./FilteredSelectPopover.module.css";

export function FilteredSelectFooter({
  title,
  options,
}: {
  title?: ReactNode;
  options: readonly FilteredSelectFooterOption[];
}) {
  if (!title && options.length === 0) return null;

  return (
    <div className={styles.footer} data-slot="filtered-select-footer">
      {title ? (
        <div className={styles.footerTitle} data-slot="filtered-select-footer-title">
          {title}
        </div>
      ) : null}
      <div className={styles.footerOptions}>
        {options.map((option) => (
          <Button
            key={option.id}
            size="xs"
            shape="pill"
            variant={option.selected ? "secondary" : "borderless"}
            data-selected={option.selected ? "true" : undefined}
            onClick={option.onSelect}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
