import { Fragment } from "react";
import { ArrowRight } from "../Icons";
import styles from "./Breadcrumb.module.css";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbProps {
  /** Trail from the root; the last item is the current page. */
  items: BreadcrumbItem[];
  label?: string;
}

export function Breadcrumb({ items, label = "현재 위치" }: BreadcrumbProps) {
  return (
    <nav aria-label={label} data-slot="breadcrumb">
      <ol className={styles.list}>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <Fragment key={`${item.label}-${index}`}>
              {index > 0 ? <li aria-hidden="true" className={styles.separator}><ArrowRight size="sm" /></li> : null}
              <li className={styles.item}>
                {current ? (
                  <span aria-current="page" className={styles.page}>{item.label}</span>
                ) : item.href ? (
                  <a className={styles.link} href={item.href}>{item.label}</a>
                ) : (
                  <span>{item.label}</span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
