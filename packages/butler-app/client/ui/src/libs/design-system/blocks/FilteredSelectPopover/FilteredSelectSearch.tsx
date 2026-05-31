import { Input } from "../../components/Input";
import { X } from "../../components/Icons";
import styles from "./FilteredSelectPopover.module.css";

export interface FilteredSelectSearchProps {
  label: string;
  placeholder: string;
  value: string;
  clearLabel: string;
  onChange: (value: string) => void;
}

export function FilteredSelectSearch({
  label,
  placeholder,
  value,
  clearLabel,
  onChange,
}: FilteredSelectSearchProps) {
  return (
    <label className={styles.searchLabel}>
      <span className={styles.srOnly}>{label}</span>
      <span className={styles.searchControl}>
        <Input
          className={styles.searchInput}
          value={value}
          placeholder={placeholder}
          data-test-class="filtered-select-search"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {value ? (
          <button
            type="button"
            aria-label={clearLabel}
            className={styles.clearButton}
            data-test-class="filtered-select-clear"
            onClick={() => onChange("")}
          >
            <X size={13} />
          </button>
        ) : null}
      </span>
    </label>
  );
}
