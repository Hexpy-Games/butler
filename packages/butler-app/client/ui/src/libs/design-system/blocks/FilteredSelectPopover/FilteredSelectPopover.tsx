import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "../../components/Button";
import { cn } from "../../lib/utils";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { ScrollArea } from "../ScrollArea";
import { FilteredSelectFooter } from "./FilteredSelectFooter";
import { FilteredSelectItemButton } from "./FilteredSelectItemButton";
import { FilteredSelectSearch } from "./FilteredSelectSearch";
import styles from "./FilteredSelectPopover.module.css";
import { useSelectedRowIntoView } from "./useSelectedRowIntoView";
import { dsClass, dsStyle } from "../../lib/internal";

export interface FilteredSelectFilter {
  id: string;
  label: ReactNode;
}

export interface FilteredSelectItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  tooltipLabel?: string;
  selected?: boolean;
  icon?: ReactNode;
  onSelect?: () => void;
}

export interface FilteredSelectGroup {
  id: string;
  title: ReactNode;
  items: FilteredSelectItem[];
}

export interface FilteredSelectFooterOption {
  id: string;
  label: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}

export interface FilteredSelectPopoverProps extends DsPrivateStyleProps {
  title: ReactNode;
  searchLabel: string;
  searchPlaceholder: string;
  searchClearLabel: string;
  searchValue: string;
  filters: readonly FilteredSelectFilter[];
  activeFilterId: string;
  onSearchChange: (value: string) => void;
  onFilterChange: (id: string) => void;
  groups: readonly FilteredSelectGroup[];
  emptyLabel: ReactNode;
  footerTitle?: ReactNode;
  footerOptions?: FilteredSelectFooterOption[];
  width?: "default" | "fixed";
  resultsMaxRows?: number;
}

export function FilteredSelectPopover({
  title,
  searchLabel,
  searchPlaceholder,
  searchClearLabel,
  searchValue,
  filters,
  activeFilterId,
  onSearchChange,
  onFilterChange,
  groups,
  emptyLabel,
  footerTitle,
  footerOptions = [],
  className,
  width = "default",
  resultsMaxRows,
}: FilteredSelectPopoverProps) {
  const filtersFadeRef = useScrollEdges("x");
  const resultsRef = useSelectedRowIntoView();
  const visibleGroups = groups.filter((group) => group.items.length > 0);
  const resultsStyle = resultsMaxRows
    ? ({
        "--filtered-select-results-max-rows": resultsMaxRows,
      } as CSSProperties)
    : undefined;

  return (
    <div
      aria-label={typeof title === "string" ? title : undefined}
      className={cn(styles.root, className)}
      data-slot="filtered-select-popover"
      data-test-class="filtered-select-popover"
      data-width={width}
    >
      <div className={styles.title}>{title}</div>
      <FilteredSelectSearch
        label={searchLabel}
        placeholder={searchPlaceholder}
        clearLabel={searchClearLabel}
        value={searchValue}
        onChange={onSearchChange}
      />
      <div
        ref={filtersFadeRef}
        className={styles.filters}
        data-slot="filtered-select-filters"
      >
        {filters.map((filter) => (
          <Button
            key={filter.id}
            size="xs"
            shape="pill"
            variant={filter.id === activeFilterId ? "secondary" : "borderless"}
            data-selected={filter.id === activeFilterId ? "true" : undefined}
            onClick={() => onFilterChange(filter.id)}
          >
            {filter.label}
          </Button>
        ))}
      </div>
      <ScrollArea
        className={dsClass(styles.results)}
        contentClassName={dsClass(styles.resultsContent)}
        dataSlot="filtered-select-results"
        dataTestClass="filtered-select-results"
        scrollRef={resultsRef}
        style={dsStyle(resultsStyle)}
      >
        {visibleGroups.length > 0 ? (
          visibleGroups.map((group) => (
            <section key={group.id} className={styles.group}>
              <div
                className={styles.groupTitle}
                data-slot="filtered-select-group-title"
              >
                {group.title}
              </div>
              <div className={styles.groupItems}>
                {group.items.map((item) => (
                  <FilteredSelectItemButton key={item.id} item={item} />
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className={styles.empty}>{emptyLabel}</div>
        )}
      </ScrollArea>
      <FilteredSelectFooter title={footerTitle} options={footerOptions} />
    </div>
  );
}
