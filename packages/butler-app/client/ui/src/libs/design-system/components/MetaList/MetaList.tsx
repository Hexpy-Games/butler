import type { HTMLAttributes, ReactNode } from "react";
import styles from "./MetaList.module.css";

export interface MetaListItem {
  /** Short term such as "Input"; no leading separator or trailing colon. Omit for a value-only entry. */
  label?: ReactNode;
  value: ReactNode;
}

export interface MetaListProps extends Omit<HTMLAttributes<HTMLDListElement>, "children"> {
  items: MetaListItem[];
}

/** A wrapping run of label/value metadata in caption type ("Input 36,460  Cache 8,200"). */
export function MetaList({ items, ...props }: MetaListProps) {
  return (
    <dl className={styles.list} {...props}>
      {items.map((item, index) => (
        <div key={index} className={styles.item}>
          {item.label !== undefined ? (
            <>
              <dt className={styles.label}>{item.label}</dt>{" "}
            </>
          ) : null}
          <dd className={styles.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default MetaList;
