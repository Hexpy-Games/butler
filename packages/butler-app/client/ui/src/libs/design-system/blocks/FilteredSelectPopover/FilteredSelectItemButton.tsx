import { Tooltip } from "../../components/Tooltip";
import type { FilteredSelectItem } from "./FilteredSelectPopover";
import styles from "./FilteredSelectPopover.module.css";

export function FilteredSelectItemButton({
  item,
}: {
  item: FilteredSelectItem;
}) {
  const button = (
    <button
      type="button"
      aria-current={item.selected ? "true" : undefined}
      className={styles.item}
      data-has-icon={item.icon ? "true" : undefined}
      data-selected={item.selected ? "true" : undefined}
      data-slot="filtered-select-item"
      onClick={item.onSelect}
    >
      {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
      <span className={styles.itemCopy}>
        <span className={styles.itemLabel}>{item.label}</span>
        {item.description ? (
          <span className={styles.itemDescription}>{item.description}</span>
        ) : null}
      </span>
    </button>
  );

  return item.tooltipLabel ? (
    <Tooltip label={item.tooltipLabel}>{button}</Tooltip>
  ) : (
    button
  );
}
